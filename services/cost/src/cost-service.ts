/**
 * @module cost-service
 * Cost_Service: Usage metering, budget enforcement, and cost reporting.
 *
 * - Meter every billable event (model invocations, sandbox executions, storage)
 * - Attribute to tenant_id and principal_id
 * - Apply daily and monthly budgets with warning alerts at thresholds
 * - Signal LLM_Gateway and Code_Sandbox_Service to reject on hard budget exceeded
 * - Produce per-tenant/per-principal cost reports with daily granularity (retain 24 months)
 *
 * @see Requirements 34.1–34.5
 */

import type { UsageEvent, BudgetConfig } from '@may/types';

// ─── Budget Status Types ───────────────────────────────────────────────────────

export interface BudgetStatus {
  readonly tenant_id: string;
  readonly principal_id?: string;
  readonly daily_used: number;
  readonly daily_limit: number;
  readonly monthly_used: number;
  readonly monthly_limit: number;
  readonly daily_exhausted: boolean;
  readonly monthly_exhausted: boolean;
  readonly exceeded: boolean;
}

export interface CostReport {
  readonly tenant_id: string;
  readonly principal_id?: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly total_cost_units: number;
  readonly breakdown_by_resource: Readonly<Record<string, number>>;
  readonly daily_breakdown: readonly { date: string; cost_units: number }[];
}

export interface BudgetAlertEvent {
  readonly alert_id: string;
  readonly tenant_id: string;
  readonly principal_id?: string;
  readonly threshold_fraction: number;
  readonly current_fraction: number;
  readonly period: 'daily' | 'monthly';
  readonly timestamp: string;
}

// ─── Store Interfaces ─────────────────────────────────────────────────────────

export interface ICostEventStore {
  save(event: UsageEvent): Promise<void>;
  findByTenant(tenantId: string, from: string, to: string): Promise<readonly UsageEvent[]>;
  findByPrincipal(tenantId: string, principalId: string, from: string, to: string): Promise<readonly UsageEvent[]>;
  sumByTenantForPeriod(tenantId: string, from: string, to: string): Promise<number>;
  sumByPrincipalForPeriod(tenantId: string, principalId: string, from: string, to: string): Promise<number>;
}

export interface IBudgetConfigStore {
  getBudget(tenantId: string, principalId?: string): Promise<BudgetConfig | null>;
  saveBudget(config: BudgetConfig): Promise<void>;
}

export interface ICostAlertEmitter {
  emitBudgetAlert(alert: BudgetAlertEvent): Promise<void>;
}

export interface ICostIdGenerator { uuid(): string; }
export interface ICostClock {
  nowISO(): string;
  startOfDay(date?: string): string;
  startOfMonth(date?: string): string;
  endOfDay(date?: string): string;
  endOfMonth(date?: string): string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface CostServiceDeps {
  readonly eventStore: ICostEventStore;
  readonly budgetStore: IBudgetConfigStore;
  readonly alertEmitter: ICostAlertEmitter;
  readonly idGenerator: ICostIdGenerator;
  readonly clock: ICostClock;
}

export class CostService {
  private readonly eventStore: ICostEventStore;
  private readonly budgetStore: IBudgetConfigStore;
  private readonly alertEmitter: ICostAlertEmitter;
  private readonly idGenerator: ICostIdGenerator;
  private readonly clock: ICostClock;

  constructor(deps: CostServiceDeps) {
    this.eventStore = deps.eventStore;
    this.budgetStore = deps.budgetStore;
    this.alertEmitter = deps.alertEmitter;
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
  }

  /**
   * Record a billable usage event and check budget thresholds.
   *
   * @see Requirement 34.1 — meter every billable event, attribute to tenant+principal
   * @see Requirement 34.2 — warning alerts at configured thresholds
   */
  async recordUsage(event: UsageEvent): Promise<BudgetStatus> {
    // Validate attribution is present
    if (!event.tenant_id || !event.principal_id) {
      throw new Error('ATTRIBUTION_REQUIRED: tenant_id and principal_id must be set on every usage event');
    }

    await this.eventStore.save(event);

    const status = await this.getBudgetStatus(event.tenant_id, event.principal_id);

    // Emit warning alerts at configured thresholds (Requirement 34.2)
    await this.checkAndEmitAlerts(event.tenant_id, event.principal_id, status);

    return status;
  }

  /**
   * Check if a tenant/principal has exceeded their budget.
   *
   * Returns true if budget is exceeded (should reject request).
   *
   * @see Requirement 34.3 — hard budget enforcement (reject on exceeded)
   */
  async isBudgetExceeded(tenantId: string, principalId: string): Promise<boolean> {
    const status = await this.getBudgetStatus(tenantId, principalId);
    return status.exceeded;
  }

  /**
   * Get current budget status for a tenant/principal.
   */
  async getBudgetStatus(tenantId: string, principalId: string): Promise<BudgetStatus> {
    const now = this.clock.nowISO();
    const dayStart = this.clock.startOfDay(now);
    const dayEnd = this.clock.endOfDay(now);
    const monthStart = this.clock.startOfMonth(now);
    const monthEnd = this.clock.endOfMonth(now);

    const [dailyUsed, monthlyUsed, budget] = await Promise.all([
      this.eventStore.sumByPrincipalForPeriod(tenantId, principalId, dayStart, dayEnd),
      this.eventStore.sumByPrincipalForPeriod(tenantId, principalId, monthStart, monthEnd),
      this.budgetStore.getBudget(tenantId, principalId),
    ]);

    // Fall back to tenant-level budget
    const tenantBudget = budget ?? await this.budgetStore.getBudget(tenantId);

    if (!tenantBudget) {
      // No budget configured — allow all
      return {
        tenant_id: tenantId,
        principal_id: principalId,
        daily_used: dailyUsed,
        daily_limit: Infinity,
        monthly_used: monthlyUsed,
        monthly_limit: Infinity,
        daily_exhausted: false,
        monthly_exhausted: false,
        exceeded: false,
      };
    }

    const dailyExhausted = tenantBudget.hard_limit_action === 'reject'
      ? dailyUsed >= tenantBudget.daily_limit
      : false;
    const monthlyExhausted = tenantBudget.hard_limit_action === 'reject'
      ? monthlyUsed >= tenantBudget.monthly_limit
      : false;

    return {
      tenant_id: tenantId,
      principal_id: principalId,
      daily_used: dailyUsed,
      daily_limit: tenantBudget.daily_limit,
      monthly_used: monthlyUsed,
      monthly_limit: tenantBudget.monthly_limit,
      daily_exhausted: dailyExhausted,
      monthly_exhausted: monthlyExhausted,
      exceeded: dailyExhausted || monthlyExhausted,
    };
  }

  /**
   * Configure budget for a tenant or principal.
   */
  async configureBudget(config: BudgetConfig): Promise<void> {
    await this.budgetStore.saveBudget(config);
  }

  /**
   * Produce cost report for a tenant/principal with daily granularity.
   *
   * Reports are retained for up to 24 months (Requirement 34.5).
   *
   * @see Requirement 34.5 — per-tenant/per-principal reports, daily granularity
   */
  async getCostReport(
    tenantId: string,
    principalId: string | undefined,
    from: string,
    to: string,
  ): Promise<CostReport> {
    const events = principalId
      ? await this.eventStore.findByPrincipal(tenantId, principalId, from, to)
      : await this.eventStore.findByTenant(tenantId, from, to);

    const totalCost = events.reduce((sum, e) => sum + e.cost_units, 0);
    const byResource: Record<string, number> = {};
    const byDay: Record<string, number> = {};

    for (const event of events) {
      byResource[event.resource_type] = (byResource[event.resource_type] ?? 0) + event.cost_units;
      const day = event.timestamp.slice(0, 10); // YYYY-MM-DD
      byDay[day] = (byDay[day] ?? 0) + event.cost_units;
    }

    const daily_breakdown = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost_units]) => ({ date, cost_units }));

    return {
      tenant_id: tenantId,
      principal_id: principalId,
      period_start: from,
      period_end: to,
      total_cost_units: totalCost,
      breakdown_by_resource: byResource,
      daily_breakdown,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async checkAndEmitAlerts(
    tenantId: string,
    principalId: string,
    status: BudgetStatus,
  ): Promise<void> {
    const budget = await this.budgetStore.getBudget(tenantId, principalId)
      ?? await this.budgetStore.getBudget(tenantId);

    if (!budget || status.daily_limit === Infinity) return;

    const now = this.clock.nowISO();

    for (const threshold of budget.warning_thresholds) {
      const dailyFraction = status.daily_used / status.daily_limit;
      const monthlyFraction = status.monthly_used / status.monthly_limit;

      if (dailyFraction >= threshold) {
        await this.alertEmitter.emitBudgetAlert({
          alert_id: this.idGenerator.uuid(),
          tenant_id: tenantId,
          principal_id: principalId,
          threshold_fraction: threshold,
          current_fraction: dailyFraction,
          period: 'daily',
          timestamp: now,
        });
      }

      if (monthlyFraction >= threshold) {
        await this.alertEmitter.emitBudgetAlert({
          alert_id: this.idGenerator.uuid(),
          tenant_id: tenantId,
          principal_id: principalId,
          threshold_fraction: threshold,
          current_fraction: monthlyFraction,
          period: 'monthly',
          timestamp: now,
        });
      }
    }
  }
}

// ─── In-Memory Store implementations ─────────────────────────────────────────

export class InMemoryCostEventStore implements ICostEventStore {
  private readonly events: UsageEvent[] = [];

  async save(event: UsageEvent): Promise<void> {
    this.events.push(event);
  }

  async findByTenant(tenantId: string, from: string, to: string): Promise<readonly UsageEvent[]> {
    return this.events.filter(
      (e) => e.tenant_id === tenantId && e.timestamp >= from && e.timestamp <= to,
    );
  }

  async findByPrincipal(tenantId: string, principalId: string, from: string, to: string): Promise<readonly UsageEvent[]> {
    return this.events.filter(
      (e) => e.tenant_id === tenantId && e.principal_id === principalId && e.timestamp >= from && e.timestamp <= to,
    );
  }

  async sumByTenantForPeriod(tenantId: string, from: string, to: string): Promise<number> {
    return (await this.findByTenant(tenantId, from, to)).reduce((s, e) => s + e.cost_units, 0);
  }

  async sumByPrincipalForPeriod(tenantId: string, principalId: string, from: string, to: string): Promise<number> {
    return (await this.findByPrincipal(tenantId, principalId, from, to)).reduce((s, e) => s + e.cost_units, 0);
  }
}

export class InMemoryBudgetConfigStore implements IBudgetConfigStore {
  private readonly budgets = new Map<string, BudgetConfig>();

  async getBudget(tenantId: string, principalId?: string): Promise<BudgetConfig | null> {
    const key = principalId ? `${tenantId}:${principalId}` : tenantId;
    return this.budgets.get(key) ?? null;
  }

  async saveBudget(config: BudgetConfig): Promise<void> {
    const key = config.principal_id ? `${config.tenant_id}:${config.principal_id}` : config.tenant_id;
    this.budgets.set(key, config);
  }
}
