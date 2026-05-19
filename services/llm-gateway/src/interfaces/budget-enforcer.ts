/**
 * Budget enforcer interfaces for the LLM Gateway.
 *
 * Tracks token/cost usage against configured limits per tenant and principal.
 * Rejects requests with BUDGET_EXCEEDED when the tenant's metered cost in the
 * current billing period exceeds the configured budget.
 *
 * @see Requirement 4.8 — reject with BUDGET_EXCEEDED when tenant budget exceeded
 */

/**
 * Result of a budget enforcement check.
 */
export interface BudgetCheckResult {
  /** Whether the request is allowed within budget. */
  readonly allowed: boolean;

  /** Current usage in cost units for the period. */
  readonly current_usage: number;

  /** Configured limit in cost units for the period. */
  readonly limit: number;

  /** Remaining budget in cost units. */
  readonly remaining: number;

  /** The period type that was checked (daily or monthly). */
  readonly period: 'daily' | 'monthly';

  /** The tenant whose budget was checked. */
  readonly tenant_id: string;
}

/**
 * Budget configuration for enforcement.
 */
export interface BudgetEnforcementConfig {
  /** Tenant identifier. */
  readonly tenant_id: string;

  /** Maximum cost units allowed per day. */
  readonly daily_limit: number;

  /** Maximum cost units allowed per month. */
  readonly monthly_limit: number;

  /** Action to take when hard limit is exceeded. */
  readonly hard_limit_action: 'reject' | 'alert_only';

  /** Warning threshold fractions (e.g., [0.5, 0.75, 0.9]). */
  readonly warning_thresholds: readonly number[];
}

/**
 * Usage record for tracking cost consumption.
 */
export interface UsageRecord {
  /** Cost units consumed. */
  readonly cost_units: number;

  /** ISO 8601 timestamp of the usage. */
  readonly timestamp: string;

  /** Model that was invoked. */
  readonly model_id: string;

  /** Principal who made the request. */
  readonly principal_id: string;

  /** Token counts for the invocation. */
  readonly tokens: {
    readonly prompt: number;
    readonly completion: number;
  };
}

/**
 * Budget enforcer interface for the LLM Gateway.
 *
 * Tracks usage against configured budgets and rejects requests when
 * limits are exceeded. Emits warning events at configured thresholds.
 *
 * @see Requirement 4.8 — reject with BUDGET_EXCEEDED when tenant budget exceeded
 */
export interface IBudgetEnforcer {
  /**
   * Check if a request is allowed within the tenant's budget.
   * Does NOT record usage — call recordUsage after successful invocation.
   *
   * @param tenantId - The tenant making the request
   * @param estimatedCost - Estimated cost units for the request
   * @returns Budget check result
   */
  checkBudget(tenantId: string, estimatedCost: number): BudgetCheckResult;

  /**
   * Record actual usage after a successful model invocation.
   *
   * @param record - The usage record to track
   */
  recordUsage(record: UsageRecord): void;

  /**
   * Configure budget limits for a tenant.
   *
   * @param config - Budget configuration
   */
  configure(config: BudgetEnforcementConfig): void;

  /**
   * Get current budget status for a tenant.
   *
   * @param tenantId - The tenant to check
   * @returns Budget check result with current usage
   */
  getStatus(tenantId: string): BudgetCheckResult;

  /**
   * Reset usage counters for a tenant (e.g., at period boundary).
   *
   * @param tenantId - The tenant to reset
   * @param period - Which period to reset
   */
  resetPeriod(tenantId: string, period: 'daily' | 'monthly'): void;
}
