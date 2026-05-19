/**
 * @module confirmation-challenge-service
 * Implementation of IConfirmationChallengeService.
 *
 * Issues and validates single-use, server-generated nonce challenges for
 * HIGH/CRITICAL risk actions. Prevents replay attacks by binding each
 * challenge to a specific action request and session with a 60-second expiry.
 *
 * @see Requirement 24.1 - Issue challenge with server nonce, 60s expiry, action description
 * @see Requirement 24.2 - HUD_Client displays nonce (handled by HUD, not this service)
 * @see Requirement 24.3 - End_User satisfies via voice or HUD input (handled by client)
 * @see Requirement 24.4 - Accept only when all 4 conditions hold
 * @see Requirement 24.5 - Reject on failure, invalidate nonce, emit audit, apply lockout
 * @see Requirement 24.6 - Bind challenge to specific action_request_id
 */

import type { ConfirmationChallenge, ChallengeId, ISOTimestamp } from '@may/types';
import type { IClock, IIdGenerator } from './interfaces/index.js';
import type {
  IConfirmationChallengeService,
  IChallengeStore,
  ILockoutStore,
  INonceGenerator,
  IChallengeAuditEmitter,
  IssueChallengeRequest,
  ValidateChallengeRequest,
  ChallengeValidationResult,
  ConfirmationChallengeConfig,
} from './interfaces/confirmation-challenge.js';

// ─── Default Configuration ───────────────────────────────────────────────────

/**
 * Maximum challenge expiry in seconds (per Requirement 24.1).
 */
export const MAX_CHALLENGE_EXPIRY_SECONDS = 60;

/**
 * Default number of consecutive failures before lockout.
 */
export const DEFAULT_MAX_FAILURES_BEFORE_LOCKOUT = 5;

/**
 * Default lockout duration in seconds (5 minutes).
 */
export const DEFAULT_LOCKOUT_DURATION_SECONDS = 300;

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Dependencies required by the ConfirmationChallengeService.
 * All external dependencies are injected for testability.
 */
export interface ConfirmationChallengeServiceDependencies {
  /** Store for persisting challenges. */
  readonly challengeStore: IChallengeStore;
  /** Store for tracking lockout state. */
  readonly lockoutStore: ILockoutStore;
  /** Cryptographic nonce generator. */
  readonly nonceGenerator: INonceGenerator;
  /** Audit event emitter for challenge operations. */
  readonly auditEmitter: IChallengeAuditEmitter;
  /** Clock abstraction for testable time-dependent logic. */
  readonly clock: IClock;
  /** ID generator for creating unique identifiers. */
  readonly idGenerator: IIdGenerator;
  /** Service configuration. */
  readonly config: ConfirmationChallengeConfig;
}

// ─── Service Implementation ──────────────────────────────────────────────────

/**
 * Production implementation of the Confirmation_Challenge service.
 *
 * Issuance flow:
 * 1. Generate cryptographically random nonce (32 bytes, hex encoded)
 * 2. Create challenge with 60s expiry, bound to action_request_id and session_id
 * 3. Persist challenge
 * 4. Emit CHALLENGE_ISSUED audit event
 * 5. Return challenge to caller
 *
 * Validation flow:
 * 1. Check session lockout status
 * 2. Retrieve challenge from store
 * 3. Validate all four conditions (nonce, expiry, session, consumed)
 * 4. On success: mark consumed, reset lockout counter, emit audit
 * 5. On failure: invalidate challenge, record failure, apply lockout if threshold reached, emit audit
 */
export class ConfirmationChallengeService implements IConfirmationChallengeService {
  private readonly challengeStore: IChallengeStore;
  private readonly lockoutStore: ILockoutStore;
  private readonly nonceGenerator: INonceGenerator;
  private readonly auditEmitter: IChallengeAuditEmitter;
  private readonly clock: IClock;
  private readonly idGenerator: IIdGenerator;
  private readonly config: ConfirmationChallengeConfig;

  constructor(deps: ConfirmationChallengeServiceDependencies) {
    this.challengeStore = deps.challengeStore;
    this.lockoutStore = deps.lockoutStore;
    this.nonceGenerator = deps.nonceGenerator;
    this.auditEmitter = deps.auditEmitter;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
    this.config = deps.config;
  }

  /**
   * Issue a new Confirmation_Challenge for a HIGH/CRITICAL action.
   *
   * @param request - The challenge issuance request
   * @returns The issued ConfirmationChallenge with server nonce and 60s expiry
   */
  async issueChallenge(request: IssueChallengeRequest): Promise<ConfirmationChallenge> {
    const { action_request_id, session_id, action_description, correlation_id } = request;

    // Generate unique challenge ID and cryptographic nonce
    const challengeId = this.idGenerator.uuid() as ChallengeId;
    const nonce = this.nonceGenerator.generate();

    // Calculate expiry: exactly expirySeconds from now (max 60s per Requirement 24.1)
    const expirySeconds = Math.min(this.config.expirySeconds, MAX_CHALLENGE_EXPIRY_SECONDS);
    const nowSeconds = this.clock.nowSeconds();
    const expiresAt = new Date((nowSeconds + expirySeconds) * 1000).toISOString() as ISOTimestamp;

    // Create the challenge
    const challenge: ConfirmationChallenge = {
      challenge_id: challengeId,
      nonce,
      action_request_id,
      session_id,
      expires_at: expiresAt,
      action_description,
      consumed: false,
    };

    // Persist the challenge
    await this.challengeStore.store(challenge);

    // Emit audit event for challenge issuance
    await this.auditEmitter.emit(
      {
        event_type: 'CHALLENGE_ISSUED',
        challenge_id: challengeId as string,
        session_id: session_id as string,
        action_request_id: action_request_id as string,
      },
      correlation_id,
    );

    return challenge;
  }

  /**
   * Validate a Confirmation_Challenge response.
   *
   * Checks all four conditions per Requirement 24.4:
   * 1. Nonce match
   * 2. Not expired
   * 3. Same session
   * 4. Not consumed (single-use)
   *
   * @param request - The validation request containing the user's response
   * @returns Validation result with success/failure and reason
   */
  async validateChallenge(request: ValidateChallengeRequest): Promise<ChallengeValidationResult> {
    const { response, correlation_id } = request;
    const { challenge_id, nonce, session_id } = response;

    // Step 1: Check if session is locked out
    const isLockedOut = await this.lockoutStore.isLockedOut(session_id);
    if (isLockedOut) {
      await this.auditEmitter.emit(
        {
          event_type: 'CHALLENGE_FAILED',
          challenge_id: challenge_id as string,
          session_id: session_id as string,
          action_request_id: '',
          rejection_reason: 'SESSION_LOCKED_OUT',
        },
        correlation_id,
      );
      return {
        valid: false,
        rejection_reason: 'SESSION_LOCKED_OUT',
        locked_out: true,
      };
    }

    // Step 2: Retrieve challenge from store
    const challenge = await this.challengeStore.get(challenge_id);
    if (!challenge) {
      await this.handleFailure(session_id, challenge_id as string, '', 'CHALLENGE_NOT_FOUND', correlation_id);
      return {
        valid: false,
        rejection_reason: 'CHALLENGE_NOT_FOUND',
      };
    }

    // Step 3: Validate all four conditions

    // Condition 4: Not consumed (check first to avoid leaking timing info)
    if (challenge.consumed) {
      await this.handleFailure(
        session_id,
        challenge_id as string,
        challenge.action_request_id as string,
        'ALREADY_CONSUMED',
        correlation_id,
      );
      return {
        valid: false,
        rejection_reason: 'ALREADY_CONSUMED',
      };
    }

    // Condition 1: Nonce match
    if (nonce !== challenge.nonce) {
      await this.challengeStore.invalidate(challenge_id);
      await this.handleFailure(
        session_id,
        challenge_id as string,
        challenge.action_request_id as string,
        'NONCE_MISMATCH',
        correlation_id,
      );
      return {
        valid: false,
        rejection_reason: 'NONCE_MISMATCH',
      };
    }

    // Condition 2: Not expired
    const nowMs = this.clock.nowSeconds() * 1000;
    const expiresAtMs = new Date(challenge.expires_at as string).getTime();
    if (nowMs >= expiresAtMs) {
      await this.challengeStore.invalidate(challenge_id);
      await this.handleFailure(
        session_id,
        challenge_id as string,
        challenge.action_request_id as string,
        'EXPIRED',
        correlation_id,
      );
      return {
        valid: false,
        rejection_reason: 'EXPIRED',
      };
    }

    // Condition 3: Same session
    if (session_id !== challenge.session_id) {
      await this.challengeStore.invalidate(challenge_id);
      await this.handleFailure(
        session_id,
        challenge_id as string,
        challenge.action_request_id as string,
        'SESSION_MISMATCH',
        correlation_id,
      );
      return {
        valid: false,
        rejection_reason: 'SESSION_MISMATCH',
      };
    }

    // All conditions passed — mark as consumed and reset lockout
    await this.challengeStore.markConsumed(challenge_id);
    await this.lockoutStore.resetFailures(session_id);

    // Emit success audit event
    await this.auditEmitter.emit(
      {
        event_type: 'CHALLENGE_VALIDATED',
        challenge_id: challenge_id as string,
        session_id: session_id as string,
        action_request_id: challenge.action_request_id as string,
      },
      correlation_id,
    );

    return {
      valid: true,
      action_request_id: challenge.action_request_id,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Handle a failed validation attempt.
   * Records the failure, applies progressive lockout if threshold reached,
   * and emits appropriate audit events.
   */
  private async handleFailure(
    sessionId: string,
    challengeId: string,
    actionRequestId: string,
    reason: ChallengeValidationResult['rejection_reason'] & string,
    correlationId: string,
  ): Promise<void> {
    // Record failure and get new count
    const failureCount = await this.lockoutStore.recordFailure(sessionId as any);

    // Emit failure audit event
    await this.auditEmitter.emit(
      {
        event_type: 'CHALLENGE_FAILED',
        challenge_id: challengeId,
        session_id: sessionId,
        action_request_id: actionRequestId,
        rejection_reason: reason,
        failure_count: failureCount,
      },
      correlationId as any,
    );

    // Apply progressive lockout if threshold reached
    if (failureCount >= this.config.maxFailuresBeforeLockout) {
      const lockoutUntilMs =
        this.clock.nowSeconds() * 1000 + this.config.lockoutDurationSeconds * 1000;
      const lockoutUntil = new Date(lockoutUntilMs).toISOString();

      await this.lockoutStore.lockOut(sessionId as any, lockoutUntil);

      // Emit lockout audit event
      await this.auditEmitter.emit(
        {
          event_type: 'CHALLENGE_LOCKOUT_TRIGGERED',
          challenge_id: challengeId,
          session_id: sessionId,
          action_request_id: actionRequestId,
          failure_count: failureCount,
          lockout_until: lockoutUntil,
        },
        correlationId as any,
      );
    }
  }
}
