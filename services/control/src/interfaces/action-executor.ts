/**
 * @module action-executor interfaces
 * Contracts for the ActionExecutor service — risk-level confirmation,
 * authorization, audit emission, and action lifecycle management.
 *
 * @see Requirement 2.1 - Accept ActionRequest with Risk_Level validation
 * @see Requirement 2.2 - Evaluate authorization policy within 2 seconds
 * @see Requirement 2.3 - Execute SAFE/LOW without confirmation
 * @see Requirement 2.4 - Require session-level confirmation for MEDIUM (120s timeout)
 * @see Requirement 2.5 - Require Confirmation_Challenge for HIGH/CRITICAL
 * @see Requirement 2.10 - Reject invalid/missing Risk_Level with validation error
 * @see Requirement 2.11 - Reject unauthorized actions with DENIED
 */

import type {
  ActionId,
  ActionRequest,
  ActionResponse,
  ActionOutcome,
  RiskLevel,
  CorrelationId,
  SessionId,
  ConfirmationChallenge,
  ChallengeResponse,
} from '@may/types';
import type { IClock, IIdGenerator } from './common.js';

// ─── Action Lifecycle States ─────────────────────────────────────────────────

/**
 * Action lifecycle states.
 * pending → confirmed → executing → completed/failed
 */
export type ActionState =
  | 'pending'
  | 'awaiting_confirmation'
  | 'awaiting_challenge'
  | 'confirmed'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'denied';

// ─── Authorization Client Interface ─────────────────────────────────────────

/**
 * Result of an authorization evaluation.
 */
export interface AuthorizationDecision {
  /** Whether the action is authorized. */
  readonly allowed: boolean;
  /** Reason for the decision. */
  readonly reason: string;
  /** The matched policy (if allowed). */
  readonly matched_policy?: string;
}

/**
 * Client interface for evaluating authorization policies.
 * Decouples the action executor from the Identity_Service implementation.
 */
export interface IAuthorizationClient {
  /**
   * Evaluate whether the given action request is authorized.
   *
   * @param request - The action request to evaluate
   * @returns Authorization decision
   */
  evaluate(request: ActionRequest): Promise<AuthorizationDecision>;
}

// ─── Confirmation Challenge Client Interface ─────────────────────────────────

/**
 * Client interface for the Confirmation_Challenge system.
 * Used for HIGH/CRITICAL risk actions.
 */
export interface IConfirmationChallengeClient {
  /**
   * Issue a new confirmation challenge for a HIGH/CRITICAL action.
   *
   * @param actionId - The action request ID to bind the challenge to
   * @param sessionId - The session in which the challenge is issued
   * @param actionDescription - Human-readable description of the action
   * @param correlationId - Correlation ID for tracing
   * @returns The issued confirmation challenge
   */
  issueChallenge(
    actionId: ActionId,
    sessionId: SessionId,
    actionDescription: string,
    correlationId: CorrelationId,
  ): Promise<ConfirmationChallenge>;

  /**
   * Validate a challenge response.
   *
   * @param response - The user's challenge response
   * @param correlationId - Correlation ID for tracing
   * @returns Whether the challenge was validated successfully
   */
  validateChallenge(
    response: ChallengeResponse,
    correlationId: CorrelationId,
  ): Promise<{ valid: boolean; rejection_reason?: string }>;
}

// ─── Session Confirmation Store ──────────────────────────────────────────────

/**
 * A record of a session-level confirmation for MEDIUM risk actions.
 */
export interface SessionConfirmation {
  /** The action class (action_type) that was confirmed. */
  readonly action_class: string;
  /** The session in which the confirmation was given. */
  readonly session_id: SessionId;
  /** When the confirmation was given (ISO timestamp). */
  readonly confirmed_at: string;
}

/**
 * Store for tracking session-level confirmations for MEDIUM risk actions.
 * Once an action class is confirmed in a session, subsequent actions of the
 * same class do not require re-confirmation.
 */
export interface ISessionConfirmationStore {
  /**
   * Check if an action class has been confirmed in the current session.
   *
   * @param actionClass - The action type/class
   * @param sessionId - The session to check
   * @returns True if already confirmed in this session
   */
  isConfirmed(actionClass: string, sessionId: SessionId): Promise<boolean>;

  /**
   * Record a confirmation for an action class in a session.
   *
   * @param confirmation - The confirmation record
   */
  recordConfirmation(confirmation: SessionConfirmation): Promise<void>;
}

// ─── User Confirmation Gateway ───────────────────────────────────────────────

/**
 * Request for user confirmation (MEDIUM risk actions).
 */
export interface UserConfirmationRequest {
  /** The action ID awaiting confirmation. */
  readonly action_id: ActionId;
  /** Human-readable description of the action. */
  readonly action_description: string;
  /** The action type. */
  readonly action_type: string;
  /** Maximum time to wait for confirmation in seconds. */
  readonly timeout_seconds: number;
}

/**
 * Response from user confirmation.
 */
export interface UserConfirmationResponse {
  /** Whether the user confirmed the action. */
  readonly confirmed: boolean;
  /** Whether the confirmation timed out. */
  readonly timed_out: boolean;
}

/**
 * Gateway for requesting user confirmation for MEDIUM risk actions.
 * This abstracts the HUD/UI interaction for confirmation prompts.
 */
export interface IUserConfirmationGateway {
  /**
   * Request confirmation from the user with a timeout.
   *
   * @param request - The confirmation request
   * @returns The user's response (confirmed, denied, or timed out)
   */
  requestConfirmation(request: UserConfirmationRequest): Promise<UserConfirmationResponse>;
}

// ─── Audit Emitter Interface ─────────────────────────────────────────────────

/**
 * Audit event payload for action execution.
 */
export interface ActionAuditPayload {
  /** The action ID. */
  readonly action_id: string;
  /** The principal who requested the action. */
  readonly principal_id: string;
  /** The tenant context. */
  readonly tenant_id: string;
  /** The action type. */
  readonly action_type: string;
  /** The risk level. */
  readonly risk_level: RiskLevel;
  /** The action outcome. */
  readonly outcome: ActionOutcome;
  /** Action parameters (may be redacted). */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Error details if applicable. */
  readonly error?: string;
  /** Duration in milliseconds. */
  readonly duration_ms: number;
}

/**
 * Audit emitter for action execution events.
 */
export interface IAuditEmitter {
  /**
   * Emit an action execution audit event.
   *
   * @param payload - The audit event payload
   * @param correlationId - Correlation ID for distributed tracing
   * @returns The generated audit event ID
   */
  emit(payload: ActionAuditPayload, correlationId: CorrelationId): Promise<string>;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Configuration for the ActionExecutor service.
 */
export interface ActionExecutorConfig {
  /** Default action timeout in seconds (default: 60, range: [1, 600]). */
  readonly defaultTimeoutSeconds: number;
  /** Timeout for MEDIUM risk user confirmation in seconds (default: 120). */
  readonly mediumConfirmationTimeoutSeconds: number;
  /** Maximum timeout for Confirmation_Challenge (HIGH/CRITICAL) in seconds (default: 300). */
  readonly challengeTimeoutSeconds: number;
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Dependencies required by the ActionExecutor service.
 * All external dependencies are injected for testability.
 */
export interface ActionExecutorDependencies {
  /** Client for evaluating authorization policies. */
  readonly authorizationClient: IAuthorizationClient;
  /** Client for issuing/validating confirmation challenges. */
  readonly confirmationChallengeClient: IConfirmationChallengeClient;
  /** Store for session-level confirmations (MEDIUM risk). */
  readonly sessionConfirmationStore: ISessionConfirmationStore;
  /** Gateway for requesting user confirmation (MEDIUM risk). */
  readonly userConfirmationGateway: IUserConfirmationGateway;
  /** Audit event emitter. */
  readonly auditEmitter: IAuditEmitter;
  /** Clock abstraction. */
  readonly clock: IClock;
  /** ID generator. */
  readonly idGenerator: IIdGenerator;
  /** Service configuration. */
  readonly config: ActionExecutorConfig;
}

// ─── Service Interface ───────────────────────────────────────────────────────

/**
 * ActionExecutor service — executes actions with risk-level confirmation logic.
 *
 * Lifecycle: pending → confirmed → executing → completed/failed
 *
 * @see Requirement 2.1 - Accept ActionRequest with Risk_Level field
 * @see Requirement 2.3 - Execute SAFE/LOW without confirmation
 * @see Requirement 2.4 - Require session-level confirmation for MEDIUM
 * @see Requirement 2.5 - Require Confirmation_Challenge for HIGH/CRITICAL
 * @see Requirement 2.10 - Reject invalid/missing Risk_Level
 * @see Requirement 2.11 - Reject unauthorized actions
 */
export interface IActionExecutor {
  /**
   * Execute an action request with risk-level confirmation logic.
   *
   * @param request - The action request to execute
   * @returns The action response with outcome and audit trail
   */
  executeAction(request: ActionRequest): Promise<ActionResponse>;

  /**
   * Submit a challenge response for a HIGH/CRITICAL action awaiting confirmation.
   *
   * @param actionId - The action awaiting confirmation
   * @param challengeResponse - The user's challenge response
   * @returns The action response after execution (or failure)
   */
  submitChallengeResponse(
    actionId: ActionId,
    challengeResponse: ChallengeResponse,
  ): Promise<ActionResponse>;
}
