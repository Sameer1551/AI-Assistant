/**
 * @module confirmation-challenge interfaces
 * Contracts for Confirmation_Challenge issuance and validation.
 *
 * The Confirmation_Challenge mechanism prevents replay attacks on HIGH/CRITICAL
 * risk actions by requiring a fresh, single-use, server-generated nonce that
 * binds to a specific action request and session.
 *
 * @see Requirement 24.1 - Issue challenge with nonce, 60s expiry, action description
 * @see Requirement 24.4 - Validate: nonce match, not expired, same session, not consumed
 * @see Requirement 24.5 - Reject on failure, invalidate nonce, emit audit, apply lockout
 * @see Requirement 24.6 - Bind challenge to specific action_request_id
 */

import type {
  ChallengeId,
  ActionId,
  SessionId,
  CorrelationId,
  ConfirmationChallenge,
  ChallengeResponse,
} from '@may/types';

// ─── Request/Response Types ──────────────────────────────────────────────────

/**
 * Request to issue a new Confirmation_Challenge.
 */
export interface IssueChallengeRequest {
  /** UUID of the action request this challenge authorizes. */
  readonly action_request_id: ActionId;
  /** UUID of the session in which this challenge is issued. */
  readonly session_id: SessionId;
  /** Human-readable description of the action being authorized. */
  readonly action_description: string;
  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
}

/**
 * Request to validate a Confirmation_Challenge response.
 */
export interface ValidateChallengeRequest {
  /** The user's challenge response containing nonce, challenge_id, session_id. */
  readonly response: ChallengeResponse;
  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
}

/**
 * Result of challenge validation.
 */
export interface ChallengeValidationResult {
  /** Whether the challenge response is valid. */
  readonly valid: boolean;
  /** The action_request_id the challenge was bound to (if valid). */
  readonly action_request_id?: ActionId;
  /** Reason for rejection (if invalid). */
  readonly rejection_reason?: ChallengeRejectionReason;
  /** Whether the session is now locked out due to progressive lockout. */
  readonly locked_out?: boolean;
}

/**
 * Reasons a challenge validation can be rejected.
 */
export type ChallengeRejectionReason =
  | 'CHALLENGE_NOT_FOUND'
  | 'NONCE_MISMATCH'
  | 'EXPIRED'
  | 'SESSION_MISMATCH'
  | 'ALREADY_CONSUMED'
  | 'SESSION_LOCKED_OUT';

// ─── Service Interface ───────────────────────────────────────────────────────

/**
 * Confirmation_Challenge service — issues and validates single-use nonce challenges
 * for HIGH/CRITICAL risk actions.
 *
 * @see Requirement 24.1 - Issue challenge with server nonce, 60s expiry, action binding
 * @see Requirement 24.4 - Accept only when all 4 conditions hold
 * @see Requirement 24.5 - Reject, invalidate, audit, lockout on failure
 * @see Requirement 24.6 - Bind to specific action_request_id
 */
export interface IConfirmationChallengeService {
  /**
   * Issue a new Confirmation_Challenge for a HIGH/CRITICAL action.
   *
   * Generates a cryptographically random nonce, binds it to the action request
   * and session, sets a 60-second expiry, and emits an audit event.
   *
   * @param request - The challenge issuance request
   * @returns The issued ConfirmationChallenge
   */
  issueChallenge(request: IssueChallengeRequest): Promise<ConfirmationChallenge>;

  /**
   * Validate a Confirmation_Challenge response.
   *
   * Checks all four conditions:
   * 1. Nonce match: response nonce === challenge nonce
   * 2. Not expired: current time < challenge.expires_at
   * 3. Same session: response session_id === challenge session_id
   * 4. Not consumed: challenge.consumed === false
   *
   * On success: marks challenge as consumed, resets lockout counter, emits audit.
   * On failure: invalidates nonce, applies progressive lockout, emits audit.
   *
   * @param request - The validation request containing the user's response
   * @returns Validation result indicating success or failure with reason
   */
  validateChallenge(request: ValidateChallengeRequest): Promise<ChallengeValidationResult>;
}

// ─── Challenge Store Interface ───────────────────────────────────────────────

/**
 * Persistence interface for Confirmation_Challenges.
 * Decouples the service from the storage mechanism.
 */
export interface IChallengeStore {
  /**
   * Store a newly issued challenge.
   *
   * @param challenge - The challenge to persist
   */
  store(challenge: ConfirmationChallenge): Promise<void>;

  /**
   * Retrieve a challenge by its ID.
   *
   * @param challengeId - The challenge identifier
   * @returns The stored challenge, or null if not found
   */
  get(challengeId: ChallengeId): Promise<ConfirmationChallenge | null>;

  /**
   * Mark a challenge as consumed (single-use enforcement).
   *
   * @param challengeId - The challenge to mark as consumed
   */
  markConsumed(challengeId: ChallengeId): Promise<void>;

  /**
   * Invalidate a challenge (e.g., on failed validation).
   * An invalidated challenge cannot be used again.
   *
   * @param challengeId - The challenge to invalidate
   */
  invalidate(challengeId: ChallengeId): Promise<void>;
}

// ─── Lockout Store Interface ─────────────────────────────────────────────────

/**
 * Tracks failed validation attempts per session for progressive lockout.
 */
export interface ILockoutStore {
  /**
   * Record a failed validation attempt for a session.
   *
   * @param sessionId - The session that failed validation
   * @returns The new consecutive failure count
   */
  recordFailure(sessionId: SessionId): Promise<number>;

  /**
   * Reset the failure counter for a session (on successful validation).
   *
   * @param sessionId - The session to reset
   */
  resetFailures(sessionId: SessionId): Promise<void>;

  /**
   * Get the current failure count for a session.
   *
   * @param sessionId - The session to check
   * @returns The current consecutive failure count
   */
  getFailureCount(sessionId: SessionId): Promise<number>;

  /**
   * Check if a session is currently locked out.
   *
   * @param sessionId - The session to check
   * @returns True if the session is locked out
   */
  isLockedOut(sessionId: SessionId): Promise<boolean>;

  /**
   * Lock out a session for the configured duration.
   *
   * @param sessionId - The session to lock out
   * @param until - ISO timestamp when the lockout expires
   */
  lockOut(sessionId: SessionId, until: string): Promise<void>;
}

// ─── Nonce Generator Interface ───────────────────────────────────────────────

/**
 * Generates cryptographically random nonces for challenges.
 */
export interface INonceGenerator {
  /**
   * Generate a cryptographically random nonce.
   *
   * @returns A hex-encoded random nonce (32 bytes = 64 hex chars)
   */
  generate(): string;
}

// ─── Challenge Audit Emitter Interface ───────────────────────────────────────

/**
 * Audit event types for confirmation challenges.
 */
export type ChallengeAuditEventType =
  | 'CHALLENGE_ISSUED'
  | 'CHALLENGE_VALIDATED'
  | 'CHALLENGE_FAILED'
  | 'CHALLENGE_LOCKOUT_TRIGGERED';

/**
 * Audit event payload for confirmation challenge operations.
 */
export interface ChallengeAuditPayload {
  /** The type of challenge event. */
  readonly event_type: ChallengeAuditEventType;
  /** The challenge ID involved. */
  readonly challenge_id: string;
  /** The session ID involved. */
  readonly session_id: string;
  /** The action_request_id the challenge is bound to. */
  readonly action_request_id: string;
  /** Rejection reason (for CHALLENGE_FAILED events). */
  readonly rejection_reason?: ChallengeRejectionReason;
  /** Failure count at time of event (for lockout tracking). */
  readonly failure_count?: number;
  /** Lockout expiry (for CHALLENGE_LOCKOUT_TRIGGERED events). */
  readonly lockout_until?: string;
}

/**
 * Audit emitter for confirmation challenge events.
 */
export interface IChallengeAuditEmitter {
  /**
   * Emit a challenge-related audit event.
   *
   * @param payload - The audit event payload
   * @param correlationId - Correlation ID for distributed tracing
   * @returns The generated audit event ID
   */
  emit(payload: ChallengeAuditPayload, correlationId: CorrelationId): Promise<string>;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Configuration for the Confirmation_Challenge service.
 */
export interface ConfirmationChallengeConfig {
  /** Challenge expiry duration in seconds (default: 60, max: 60). */
  readonly expirySeconds: number;
  /** Maximum consecutive failures before lockout (default: 5). */
  readonly maxFailuresBeforeLockout: number;
  /** Lockout duration in seconds (default: 300 = 5 minutes). */
  readonly lockoutDurationSeconds: number;
}
