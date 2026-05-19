/**
 * @module workflow
 * @description Data models for the Workflow_Service — durable multi-step workflow
 * execution with persistence, retry, timeout, confirmation gates, and dependency management.
 *
 * @see Requirements 8.1, 8.2, 8.3, 8.4
 */

/**
 * Status of a workflow step in its lifecycle.
 */
export type WorkflowStepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'WAITING_CONFIRMATION'
  | 'CANCELLED';

/**
 * Status of an overall workflow execution.
 */
export type WorkflowStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Retry policy with exponential backoff.
 *
 * The delay for attempt N is calculated as:
 *   delay = initial_backoff_ms × backoff_multiplier^(attempt - 1)
 *
 * The computed delay is capped at max_backoff_ms.
 *
 * @example
 * // With initial_backoff_ms=100, backoff_multiplier=2, max_backoff_ms=5000:
 * // Attempt 1: 100ms
 * // Attempt 2: 200ms
 * // Attempt 3: 400ms
 * // Attempt 4: 800ms
 * // ...capped at 5000ms
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts before marking the step as failed. */
  readonly max_retries: number;

  /** Initial backoff delay in milliseconds for the first retry attempt. */
  readonly initial_backoff_ms: number;

  /** Maximum backoff delay in milliseconds (cap for exponential growth). */
  readonly max_backoff_ms: number;

  /**
   * Multiplier applied to the backoff delay on each subsequent attempt.
   * delay = initial_backoff_ms × backoff_multiplier^(attempt - 1)
   */
  readonly backoff_multiplier: number;
}

/**
 * Resource budget constraints for a workflow or step execution.
 */
export interface ResourceBudget {
  /** Maximum CPU time in milliseconds allowed. */
  readonly max_cpu_ms?: number;

  /** Maximum memory in megabytes allowed. */
  readonly max_memory_mb?: number;

  /** Maximum cost units allowed for model invocations within this scope. */
  readonly max_cost_units?: number;
}

/**
 * An individual step within a workflow definition.
 *
 * Each step represents a discrete action with its own retry policy,
 * timeout, and dependency constraints. Steps may require confirmation
 * gates for HIGH/CRITICAL risk actions.
 */
export interface WorkflowStep {
  /** Unique identifier for this step within the workflow. */
  readonly step_id: string;

  /** Human-readable name describing the step's purpose. */
  readonly name: string;

  /** The action type to execute (e.g., "file.delete", "browser.navigate"). */
  readonly action_type: string;

  /** Parameters for the action execution. */
  readonly parameters: Record<string, unknown>;

  /**
   * Step IDs that must complete successfully before this step can execute.
   * Used for dependency graph construction and cycle detection.
   */
  readonly dependencies: readonly string[];

  /** Maximum wall-clock time in seconds allowed for this step (1-600). */
  readonly timeout_seconds: number;

  /** Retry policy specific to this step. */
  readonly retry_policy: RetryPolicy;

  /**
   * Whether this step requires a confirmation gate before execution.
   * Automatically true for HIGH/CRITICAL risk actions.
   */
  readonly requires_confirmation: boolean;

  /** Current execution status of this step. */
  status: WorkflowStepStatus;

  /** Result data from step execution, if completed. */
  result?: unknown;

  /** Error information if the step failed. */
  error?: string;

  /** Number of retry attempts made so far. */
  retry_count: number;
}

/**
 * A complete multi-step workflow definition with steps, dependencies,
 * timeouts, and resource budgets.
 *
 * The Workflow_Service persists every state transition to durable storage
 * and resumes in-progress workflows within 60 seconds of restart.
 *
 * @see Requirement 8.1 — durable persistence at every state transition
 * @see Requirement 8.3 — per-step and per-workflow timeouts and resource budgets
 * @see Requirement 8.4 — retry with exponential backoff
 */
export interface WorkflowDefinition {
  /** Unique identifier for this workflow. */
  readonly workflow_id: string;

  /** Tenant that owns this workflow. */
  readonly tenant_id: string;

  /** Principal who created this workflow. */
  readonly principal_id: string;

  /** Human-readable name for the workflow. */
  readonly name: string;

  /** Optional description of the workflow's purpose. */
  readonly description?: string;

  /** Ordered list of steps comprising the workflow. */
  readonly steps: readonly WorkflowStep[];

  /** Maximum wall-clock time in seconds for the entire workflow. */
  readonly timeout_seconds: number;

  /**
   * Optional concurrency group identifier.
   * Workflows in the same group share the tenant's concurrency limit.
   */
  readonly concurrency_group?: string;

  /** Default retry policy applied to steps that don't specify their own. */
  readonly retry_policy: RetryPolicy;

  /** Resource budget constraints for the entire workflow. */
  readonly resource_budget?: ResourceBudget;

  /** Current overall status of the workflow. */
  status: WorkflowStatus;

  /** ISO 8601 timestamp when the workflow was created. */
  readonly created_at: string;

  /** ISO 8601 timestamp when the workflow was last updated. */
  updated_at: string;

  /** ISO 8601 timestamp when the workflow completed (if terminal). */
  completed_at?: string;
}
