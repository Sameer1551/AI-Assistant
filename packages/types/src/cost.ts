/**
 * @module cost
 * Cost and budget data models for the Cost_Service.
 *
 * The Cost_Service meters every billable event, attributes usage to
 * tenant and principal, enforces daily and monthly budgets with
 * warning thresholds, and signals other services to reject requests
 * when hard budget limits are exceeded.
 *
 * @see Requirement 34.1 - Billable event metering and attribution
 */

/**
 * Types of billable resources tracked by the Cost_Service.
 */
export type ResourceType =
  | 'model_invocation'
  | 'sandbox_execution'
  | 'storage'
  | 'bandwidth';

/**
 * A billable usage event attributed to a specific tenant and principal.
 *
 * Every billable operation (model invocations, sandbox executions,
 * storage, bandwidth) generates a UsageEvent for cost tracking
 * and budget enforcement.
 */
export interface UsageEvent {
  /** Unique identifier for this usage event (UUID) */
  readonly event_id: string;

  /** Tenant boundary identifier for cost attribution */
  readonly tenant_id: string;

  /** Principal (user or service) responsible for this usage */
  readonly principal_id: string;

  /** Type of billable resource consumed */
  readonly resource_type: ResourceType;

  /** Model identifier (present for model_invocation events) */
  readonly model_id?: string;

  /** Token counts for model invocations */
  readonly token_count?: {
    /** Number of prompt/input tokens */
    readonly prompt: number;
    /** Number of completion/output tokens */
    readonly completion: number;
  };

  /** Normalized cost units for this event */
  readonly cost_units: number;

  /** ISO 8601 timestamp of when the usage occurred */
  readonly timestamp: string;
}

/**
 * Action to take when a hard budget limit is exceeded.
 *
 * - reject: Reject further requests with BUDGET_EXCEEDED error
 * - alert_only: Allow requests but emit alerts
 */
export type HardLimitAction = 'reject' | 'alert_only';

/**
 * Budget configuration for a tenant or specific principal.
 *
 * Defines daily and monthly spending limits with configurable
 * warning thresholds. When principal_id is absent, the budget
 * applies to the entire tenant.
 */
export interface BudgetConfig {
  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Optional principal-level budget (if absent, applies to entire tenant) */
  readonly principal_id?: string;

  /** Maximum cost units allowed per day */
  readonly daily_limit: number;

  /** Maximum cost units allowed per month */
  readonly monthly_limit: number;

  /**
   * Warning threshold fractions (e.g., [0.5, 0.75, 0.9]).
   * Alerts are emitted when usage crosses each threshold.
   */
  readonly warning_thresholds: readonly number[];

  /** Action to take when the hard limit is exceeded */
  readonly hard_limit_action: HardLimitAction;
}
