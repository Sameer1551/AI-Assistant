/**
 * Idempotency, timeout, and integrated action executor interfaces.
 *
 * @see Requirement 2.6 - Audit event emission within 1s of completion
 * @see Requirement 2.7 - Idempotency keys with 24h deduplication window
 * @see Requirement 2.8 - Per-action timeout enforcement
 */

import type { ActionOutcome, ActionRequest, ActionResponse } from '@may/types';

// ─── Idempotency Store ───────────────────────────────────────────────────────

/**
 * A cached action result stored for idempotency deduplication.
 */
export interface CachedActionResult {
  /** The idempotency key that identifies this cached result. */
  readonly idempotency_key: string;
  /** The cached response to return on duplicate submission. */
  readonly response: ActionResponse;
  /** ISO 8601 timestamp when this entry was stored. */
  readonly stored_at: string;
  /** ISO 8601 timestamp when this entry expires (24h after stored_at). */
  readonly expires_at: string;
}

/**
 * Store for idempotency key deduplication.
 * Implementations must support a 24-hour deduplication window.
 *
 * @see Requirement 2.7 - Re-submission with same idempotency key within 24h
 *   returns previously-recorded outcome without re-execution.
 */
export interface IIdempotencyStore {
  /**
   * Retrieves a cached result for the given idempotency key.
   * Returns null if no cached result exists or if the entry has expired.
   *
   * @param idempotencyKey - The client-generated idempotency key
   * @returns The cached result or null
   */
  get(idempotencyKey: string): Promise<CachedActionResult | null>;

  /**
   * Stores a result for the given idempotency key.
   * The entry should expire after 24 hours.
   *
   * @param idempotencyKey - The client-generated idempotency key
   * @param response - The action response to cache
   */
  set(idempotencyKey: string, response: ActionResponse): Promise<void>;

  /**
   * Checks if an idempotency key exists (not expired).
   *
   * @param idempotencyKey - The client-generated idempotency key
   * @returns True if the key exists and has not expired
   */
  has(idempotencyKey: string): Promise<boolean>;

  /**
   * Removes expired entries from the store.
   * Called periodically for cleanup.
   *
   * @returns Number of entries removed
   */
  evictExpired(): Promise<number>;
}

// ─── Timeout Enforcer ────────────────────────────────────────────────────────

/**
 * Configuration for timeout enforcement.
 */
export interface TimeoutConfig {
  /** Minimum allowed timeout in seconds. */
  readonly min_seconds: number;
  /** Maximum allowed timeout in seconds. */
  readonly max_seconds: number;
  /** Default timeout in seconds when not specified. */
  readonly default_seconds: number;
}

/**
 * Result of a timeout-enforced execution.
 */
export interface TimeoutResult<T> {
  /** Whether the operation completed within the timeout. */
  readonly completed: boolean;
  /** The result if completed, undefined if timed out. */
  readonly result?: T;
  /** Elapsed time in milliseconds. */
  readonly elapsed_ms: number;
}

/**
 * Enforces per-action timeout constraints.
 * Actions exceeding their configured timeout are terminated with TIMEOUT outcome.
 *
 * @see Requirement 2.8 - Per-action timeout (1-600s, default 60s)
 */
export interface ITimeoutEnforcer {
  /**
   * Executes an operation with a timeout constraint.
   * If the operation exceeds the timeout, it is cancelled and the result
   * indicates a timeout occurred.
   *
   * @param operation - The async operation to execute
   * @param timeoutSeconds - Timeout in seconds (must be in [1, 600])
   * @returns The result with completion status and elapsed time
   */
  executeWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutSeconds: number,
  ): Promise<TimeoutResult<T>>;

  /**
   * Validates that a timeout value is within the allowed range.
   *
   * @param timeoutSeconds - The timeout value to validate
   * @returns The validated timeout (clamped to range or default if invalid)
   */
  validateTimeout(timeoutSeconds: number | undefined): number;
}

// ─── Audit Emitter (for integrated executor) ─────────────────────────────────

/**
 * Categories for action audit events in the integrated executor.
 */
export type ActionAuditCategory =
  | 'action.started'
  | 'action.completed'
  | 'action.failed'
  | 'action.timeout'
  | 'action.cancelled'
  | 'action.denied'
  | 'action.idempotent_hit';

/**
 * Acknowledgment from the audit service after event emission.
 */
export interface AuditEmitResult {
  /** The assigned audit event ID. */
  readonly event_id: string;
  /** Whether the emission was successful. */
  readonly success: boolean;
  /** Elapsed time for the emission in milliseconds. */
  readonly emit_duration_ms: number;
}

/**
 * Emits audit events for action execution lifecycle in the integrated executor.
 * Every action execution (start, complete, fail, timeout) must emit
 * an audit event within 1 second of the event occurring.
 *
 * @see Requirement 2.6 - Emit audit event within 1s of completion
 */
export interface IIntegratedAuditEmitter {
  /**
   * Emits an audit event for an action lifecycle event.
   *
   * @param request - The original action request
   * @param category - The audit event category
   * @param outcome - The action outcome
   * @param durationMs - Elapsed time in milliseconds
   * @param details - Additional event details
   * @returns The audit emission result
   */
  emit(
    request: ActionRequest,
    category: ActionAuditCategory,
    outcome: ActionOutcome,
    durationMs: number,
    details?: Record<string, unknown>,
  ): Promise<AuditEmitResult>;
}

// ─── Action Executor (Integrated) ────────────────────────────────────────────

/**
 * Delegate that performs the actual action execution.
 * This is the function that the idempotency/timeout wrapper calls.
 */
export type ActionExecutorFn = (
  request: ActionRequest,
  signal: AbortSignal,
) => Promise<ActionResponse>;

/**
 * The combined action executor service that integrates idempotency,
 * timeout enforcement, and audit emission.
 */
export interface IActionExecutorService {
  /**
   * Executes an action with idempotency, timeout, and audit guarantees.
   *
   * 1. Checks idempotency store for cached result
   * 2. Emits action.started audit event
   * 3. Executes with timeout enforcement
   * 4. Emits completion audit event (completed/failed/timeout)
   * 5. Caches result in idempotency store
   *
   * @param request - The action request to execute
   * @param executor - The delegate that performs the actual execution
   * @returns The action response
   */
  execute(request: ActionRequest, executor: ActionExecutorFn): Promise<ActionResponse>;
}
