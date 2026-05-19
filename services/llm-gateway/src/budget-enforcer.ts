/**
 * Budget enforcement implementation for the LLM Gateway.
 *
 * Tracks token/cost usage against configured daily and monthly limits per tenant.
 * Rejects requests with BUDGET_EXCEEDED when the tenant's metered cost in the
 * current billing period exceeds the configured budget.
 *
 * @see Requirement 4.8 — reject with BUDGET_EXCEEDED when tenant budget exceeded
 */

import type {
  IBudgetEnforcer,
  BudgetCheckResult,
  BudgetEnforcementConfig,
  UsageRecord,
} from './interfaces/budget-enforcer.js';
import type { IClock } from './interfaces/index.js';

/**
 * Internal tracking state for a tenant's budget.
 */
interface TenantBudgetState {
  /** Configuration for this tenant's budget. */
  config: BudgetEnforcementConfig;

  /** Usage records for the current day. */
  dailyUsage: UsageRecord[];

  /** Usage records for the current month. */
  monthlyUsage: UsageRecord[];

  /** ISO date string for the current day (YYYY-MM-DD). */
  currentDay: string;

  /** ISO month string for the current month (YYYY-MM). */
  currentMonth: string;

  /** Warning thresholds that have already been triggered (to avoid duplicate alerts). */
  triggeredDailyThresholds: Set<number>;
  triggeredMonthlyThresholds: Set<number>;
}

/**
 * Budget enforcer implementation.
 *
 * Maintains per-tenant usage tracking with automatic period rollover.
 * Checks both daily and monthly limits, rejecting when either is exceeded
 * (if hard_limit_action is 'reject').
 *
 * @see Requirement 4.8 — reject with BUDGET_EXCEEDED when tenant budget exceeded
 */
export class BudgetEnforcer implements IBudgetEnforcer {
  private readonly tenantStates = new Map<string, TenantBudgetState>();

  constructor(private readonly clock: IClock) {}

  checkBudget(tenantId: string, estimatedCost: number): BudgetCheckResult {
    const state = this.tenantStates.get(tenantId);

    if (!state) {
      // No budget configured — allow by default
      return {
        allowed: true,
        current_usage: 0,
        limit: Infinity,
        remaining: Infinity,
        period: 'monthly',
        tenant_id: tenantId,
      };
    }

    // Roll over periods if needed
    this.rolloverIfNeeded(state);

    // Calculate current usage
    const dailyTotal = this.sumUsage(state.dailyUsage);
    const monthlyTotal = this.sumUsage(state.monthlyUsage);

    // Check daily limit first
    if (dailyTotal + estimatedCost > state.config.daily_limit) {
      if (state.config.hard_limit_action === 'reject') {
        return {
          allowed: false,
          current_usage: dailyTotal,
          limit: state.config.daily_limit,
          remaining: Math.max(0, state.config.daily_limit - dailyTotal),
          period: 'daily',
          tenant_id: tenantId,
        };
      }
    }

    // Check monthly limit
    if (monthlyTotal + estimatedCost > state.config.monthly_limit) {
      if (state.config.hard_limit_action === 'reject') {
        return {
          allowed: false,
          current_usage: monthlyTotal,
          limit: state.config.monthly_limit,
          remaining: Math.max(0, state.config.monthly_limit - monthlyTotal),
          period: 'monthly',
          tenant_id: tenantId,
        };
      }
    }

    // Both within limits
    const dailyRemaining = state.config.daily_limit - dailyTotal;
    const monthlyRemaining = state.config.monthly_limit - monthlyTotal;

    // Return the more restrictive limit
    if (dailyRemaining < monthlyRemaining) {
      return {
        allowed: true,
        current_usage: dailyTotal,
        limit: state.config.daily_limit,
        remaining: dailyRemaining,
        period: 'daily',
        tenant_id: tenantId,
      };
    }

    return {
      allowed: true,
      current_usage: monthlyTotal,
      limit: state.config.monthly_limit,
      remaining: monthlyRemaining,
      period: 'monthly',
      tenant_id: tenantId,
    };
  }

  recordUsage(record: UsageRecord): void {
    // Find the tenant state by looking through all states.
    // The record doesn't directly carry tenant_id, so we iterate.
    // In practice, the caller should use recordUsageForTenant directly.
    for (const [tenantId, tenantState] of this.tenantStates.entries()) {
      if (tenantId === this.extractTenantFromRecord(record)) {
        this.rolloverIfNeeded(tenantState);
        tenantState.dailyUsage.push(record);
        tenantState.monthlyUsage.push(record);
        this.checkWarningThresholds(tenantState);
        return;
      }
    }
  }

  /**
   * Record usage for a specific tenant.
   * This is the preferred method when the tenant_id is known.
   */
  recordUsageForTenant(tenantId: string, record: UsageRecord): void {
    const state = this.tenantStates.get(tenantId);
    if (!state) {
      return;
    }

    this.rolloverIfNeeded(state);
    state.dailyUsage.push(record);
    state.monthlyUsage.push(record);
    this.checkWarningThresholds(state);
  }

  configure(config: BudgetEnforcementConfig): void {
    const now = this.clock.nowISO();
    const currentDay = now.slice(0, 10); // YYYY-MM-DD
    const currentMonth = now.slice(0, 7); // YYYY-MM

    const existing = this.tenantStates.get(config.tenant_id);

    this.tenantStates.set(config.tenant_id, {
      config,
      dailyUsage: existing?.dailyUsage ?? [],
      monthlyUsage: existing?.monthlyUsage ?? [],
      currentDay: existing?.currentDay ?? currentDay,
      currentMonth: existing?.currentMonth ?? currentMonth,
      triggeredDailyThresholds: existing?.triggeredDailyThresholds ?? new Set(),
      triggeredMonthlyThresholds: existing?.triggeredMonthlyThresholds ?? new Set(),
    });
  }

  getStatus(tenantId: string): BudgetCheckResult {
    return this.checkBudget(tenantId, 0);
  }

  resetPeriod(tenantId: string, period: 'daily' | 'monthly'): void {
    const state = this.tenantStates.get(tenantId);
    if (!state) {
      return;
    }

    if (period === 'daily') {
      state.dailyUsage = [];
      state.triggeredDailyThresholds.clear();
      state.currentDay = this.clock.nowISO().slice(0, 10);
    } else {
      state.monthlyUsage = [];
      state.dailyUsage = [];
      state.triggeredDailyThresholds.clear();
      state.triggeredMonthlyThresholds.clear();
      state.currentMonth = this.clock.nowISO().slice(0, 7);
      state.currentDay = this.clock.nowISO().slice(0, 10);
    }
  }

  /**
   * Get warning thresholds that have been crossed.
   * Useful for testing and monitoring.
   */
  getTriggeredThresholds(tenantId: string): {
    daily: readonly number[];
    monthly: readonly number[];
  } {
    const state = this.tenantStates.get(tenantId);
    if (!state) {
      return { daily: [], monthly: [] };
    }
    return {
      daily: [...state.triggeredDailyThresholds],
      monthly: [...state.triggeredMonthlyThresholds],
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private sumUsage(records: UsageRecord[]): number {
    return records.reduce((sum, r) => sum + r.cost_units, 0);
  }

  private rolloverIfNeeded(state: TenantBudgetState): void {
    const now = this.clock.nowISO();
    const currentDay = now.slice(0, 10);
    const currentMonth = now.slice(0, 7);

    if (currentMonth !== state.currentMonth) {
      // New month — reset everything
      state.monthlyUsage = [];
      state.dailyUsage = [];
      state.currentMonth = currentMonth;
      state.currentDay = currentDay;
      state.triggeredDailyThresholds.clear();
      state.triggeredMonthlyThresholds.clear();
    } else if (currentDay !== state.currentDay) {
      // New day within same month — reset daily only
      state.dailyUsage = [];
      state.currentDay = currentDay;
      state.triggeredDailyThresholds.clear();
    }
  }

  private checkWarningThresholds(state: TenantBudgetState): void {
    const dailyTotal = this.sumUsage(state.dailyUsage);
    const monthlyTotal = this.sumUsage(state.monthlyUsage);

    for (const threshold of state.config.warning_thresholds) {
      const dailyThresholdValue = state.config.daily_limit * threshold;
      if (dailyTotal >= dailyThresholdValue && !state.triggeredDailyThresholds.has(threshold)) {
        state.triggeredDailyThresholds.add(threshold);
        // In production, this would emit a warning event/alert
      }

      const monthlyThresholdValue = state.config.monthly_limit * threshold;
      if (monthlyTotal >= monthlyThresholdValue && !state.triggeredMonthlyThresholds.has(threshold)) {
        state.triggeredMonthlyThresholds.add(threshold);
        // In production, this would emit a warning event/alert
      }
    }
  }

  private extractTenantFromRecord(_record: UsageRecord): string {
    // In a real implementation, the record would carry tenant context
    // or the caller would use recordUsageForTenant directly.
    // This is a fallback that won't match anything.
    return '';
  }
}
