/**
 * @module action
 * Action model — ActionRequest, ActionResponse, and ActionError interfaces.
 *
 * Actions are discrete operations that affect state outside the Platform
 * (filesystem, network, application UI, external APIs). Every action carries
 * a Risk_Level that determines confirmation and audit policy.
 */

import type {
  ActionId,
  IdempotencyKey,
  CorrelationId,
} from './branded.js';
import type { RequestContext } from './request-context.js';

/**
 * Risk classification for an Action.
 * Determines confirmation requirements and audit policy.
 *
 * - SAFE/LOW: Execute without confirmation
 * - MEDIUM: Requires session-level confirmation (120s timeout)
 * - HIGH/CRITICAL: Requires Confirmation_Challenge with server nonce
 */
export type RiskLevel = 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Outcome of an executed action.
 */
export type ActionOutcome = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'CANCELLED' | 'DENIED';

/**
 * A request to execute a discrete action on behalf of the user.
 *
 * @remarks
 * - action_id is server-assigned and globally unique.
 * - idempotency_key is client-generated; re-submission within 24h returns the
 *   previously-recorded outcome without re-execution.
 * - timeout_seconds must be in range [1, 600], defaulting to 60.
 */
export interface ActionRequest {
  /** UUID — unique identifier for this action instance. */
  readonly action_id: ActionId;

  /** Client-generated key for idempotent execution within a 24-hour window. */
  readonly idempotency_key: IdempotencyKey;

  /** Risk classification determining confirmation and audit policy. */
  readonly risk_level: RiskLevel;

  /**
   * The type of action to execute (e.g., "file.delete", "browser.navigate").
   * Used for authorization policy evaluation and audit categorization.
   */
  readonly action_type: string;

  /** Action-specific parameters. Structure depends on action_type. */
  readonly parameters: Readonly<Record<string, unknown>>;

  /**
   * Maximum execution time in seconds.
   * Must be in range [1, 600]. Defaults to 60 if not specified.
   */
  readonly timeout_seconds: number;

  /** The request context carrying tenant, principal, and trace information. */
  readonly context: RequestContext;
}

/**
 * Structured error information for a failed action.
 */
export interface ActionError {
  /** Machine-readable error code (e.g., "VALIDATION_ERROR", "AUTHORIZATION_DENIED"). */
  readonly code: string;

  /** Human-readable error description. */
  readonly message: string;

  /** Additional structured error details, if available. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The response returned after an action is processed.
 *
 * @remarks
 * - outcome indicates the terminal state of the action.
 * - duration_ms measures wall-clock execution time.
 * - audit_event_id links to the corresponding audit trail entry.
 */
export interface ActionResponse {
  /** UUID — matches the action_id from the originating request. */
  readonly action_id: ActionId;

  /** The idempotency key from the originating request. */
  readonly idempotency_key: IdempotencyKey;

  /** Terminal outcome of the action execution. */
  readonly outcome: ActionOutcome;

  /** Result data on SUCCESS. Structure depends on action_type. */
  readonly result_data?: unknown;

  /** Error details when outcome is FAILURE, TIMEOUT, CANCELLED, or DENIED. */
  readonly error?: ActionError;

  /** Wall-clock execution duration in milliseconds. */
  readonly duration_ms: number;

  /** UUID of the audit event emitted for this action. */
  readonly audit_event_id: string;

  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
}
