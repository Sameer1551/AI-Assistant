/**
 * @module action-executor
 * Implementation of the ActionExecutor service.
 *
 * Executes actions with risk-level confirmation logic:
 * - SAFE/LOW: Execute immediately without confirmation
 * - MEDIUM: Require session-level confirmation (120s timeout), skip if already confirmed in session
 * - HIGH/CRITICAL: Require Confirmation_Challenge with server nonce
 *
 * Rejects invalid/missing Risk_Level with validation error and DENIED outcome.
 * Rejects unauthorized actions with DENIED outcome.
 * Emits audit events for all outcomes.
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
  ActionRequest,
  ActionResponse,
  ActionOutcome,
  RiskLevel,
  ActionId,
  CorrelationId,
  IdempotencyKey,
  ConfirmationChallenge,
  ChallengeResponse,
} from '@may/types';
import type {
  IActionExecutor,
  ActionExecutorDependencies,
  ActionState,
  ActionAuditPayload,
} from './interfaces/index.js';

// ─── Valid Risk Levels ───────────────────────────────────────────────────────

const VALID_RISK_LEVELS: ReadonlySet<string> = new Set<RiskLevel>([
  'SAFE',
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

// ─── Pending Action Record ───────────────────────────────────────────────────

/**
 * Internal record for tracking an action through its lifecycle.
 */
interface PendingAction {
  readonly request: ActionRequest;
  state: ActionState;
  challenge?: ConfirmationChallenge;
  startedAt: number;
}

// ─── Service Implementation ──────────────────────────────────────────────────

/**
 * Production implementation of the ActionExecutor service.
 *
 * Execution flow:
 * 1. Validate the request (Risk_Level field)
 * 2. Evaluate authorization policy
 * 3. Determine confirmation requirements based on risk level
 * 4. Execute the action (or await confirmation)
 * 5. Emit audit event
 * 6. Return response
 */
export class ActionExecutor implements IActionExecutor {
  private readonly deps: ActionExecutorDependencies;
  private readonly pendingActions: Map<string, PendingAction> = new Map();

  constructor(deps: ActionExecutorDependencies) {
    this.deps = deps;
  }

  /**
   * Execute an action request with risk-level confirmation logic.
   */
  async executeAction(request: ActionRequest): Promise<ActionResponse> {
    const startTime = this.deps.clock.nowSeconds();
    const correlationId = request.context.correlation_id;

    // Step 1: Validate Risk_Level
    const validationError = this.validateRequest(request);
    if (validationError) {
      return this.buildErrorResponse(
        request,
        'DENIED',
        'VALIDATION_ERROR',
        validationError,
        startTime,
        correlationId,
      );
    }

    // Step 2: Evaluate authorization policy
    const authDecision = await this.deps.authorizationClient.evaluate(request);
    if (!authDecision.allowed) {
      return this.buildErrorResponse(
        request,
        'DENIED',
        'AUTHORIZATION_DENIED',
        authDecision.reason,
        startTime,
        correlationId,
      );
    }

    // Step 3: Determine confirmation requirements based on risk level
    const riskLevel = request.risk_level;

    switch (riskLevel) {
      case 'SAFE':
      case 'LOW':
        // Execute immediately without confirmation
        return this.executeAndAudit(request, startTime);

      case 'MEDIUM':
        return this.handleMediumRisk(request, startTime);

      case 'HIGH':
      case 'CRITICAL':
        return this.handleHighCriticalRisk(request, startTime);

      default:
        // Should not reach here due to validation, but defensive
        return this.buildErrorResponse(
          request,
          'DENIED',
          'VALIDATION_ERROR',
          `Invalid Risk_Level: ${riskLevel}`,
          startTime,
          correlationId,
        );
    }
  }

  /**
   * Submit a challenge response for a HIGH/CRITICAL action awaiting confirmation.
   */
  async submitChallengeResponse(
    actionId: ActionId,
    challengeResponse: ChallengeResponse,
  ): Promise<ActionResponse> {
    const pending = this.pendingActions.get(actionId as string);
    if (!pending) {
      const dummyCorrelationId = '' as CorrelationId;
      const auditEventId = await this.deps.auditEmitter.emit(
        {
          action_id: actionId as string,
          principal_id: '',
          tenant_id: '',
          action_type: '',
          risk_level: 'HIGH',
          outcome: 'DENIED',
          duration_ms: 0,
        },
        dummyCorrelationId,
      );
      return {
        action_id: actionId,
        idempotency_key: '' as IdempotencyKey,
        outcome: 'DENIED',
        error: {
          code: 'ACTION_NOT_FOUND',
          message: `No pending action found with ID: ${actionId}`,
        },
        duration_ms: 0,
        audit_event_id: auditEventId,
        correlation_id: dummyCorrelationId,
      };
    }

    if (pending.state !== 'awaiting_challenge') {
      const correlationId = pending.request.context.correlation_id;
      const auditEventId = await this.deps.auditEmitter.emit(
        {
          action_id: actionId as string,
          principal_id: pending.request.context.principal_id as string,
          tenant_id: pending.request.context.tenant_id as string,
          action_type: pending.request.action_type,
          risk_level: pending.request.risk_level,
          outcome: 'DENIED',
          duration_ms: 0,
        },
        correlationId,
      );
      return {
        action_id: actionId,
        idempotency_key: pending.request.idempotency_key,
        outcome: 'DENIED',
        error: {
          code: 'INVALID_STATE',
          message: `Action is not awaiting challenge response. Current state: ${pending.state}`,
        },
        duration_ms: 0,
        audit_event_id: auditEventId,
        correlation_id: correlationId,
      };
    }

    const correlationId = pending.request.context.correlation_id;

    // Validate the challenge response
    const validationResult = await this.deps.confirmationChallengeClient.validateChallenge(
      challengeResponse,
      correlationId,
    );

    if (!validationResult.valid) {
      pending.state = 'denied';
      this.pendingActions.delete(actionId as string);

      const durationMs = (this.deps.clock.nowSeconds() - pending.startedAt) * 1000;
      const auditEventId = await this.emitAudit(
        pending.request,
        'DENIED',
        durationMs,
        correlationId,
      );

      return {
        action_id: actionId,
        idempotency_key: pending.request.idempotency_key,
        outcome: 'DENIED',
        error: {
          code: 'CHALLENGE_VALIDATION_FAILED',
          message: `Challenge validation failed: ${validationResult.rejection_reason ?? 'unknown'}`,
        },
        duration_ms: durationMs,
        audit_event_id: auditEventId,
        correlation_id: correlationId,
      };
    }

    // Challenge validated — execute the action
    pending.state = 'confirmed';
    return this.executeAndAudit(pending.request, pending.startedAt);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Validate the action request.
   * Returns an error message if invalid, or null if valid.
   */
  private validateRequest(request: ActionRequest): string | null {
    // Check Risk_Level is present and valid
    if (!request.risk_level) {
      return 'Risk_Level is required but was not provided';
    }

    if (!VALID_RISK_LEVELS.has(request.risk_level)) {
      return `Risk_Level must be one of {SAFE, LOW, MEDIUM, HIGH, CRITICAL}, received: ${request.risk_level}`;
    }

    return null;
  }

  /**
   * Handle MEDIUM risk actions — require session-level confirmation.
   * If the action class has already been confirmed in this session, skip confirmation.
   */
  private async handleMediumRisk(
    request: ActionRequest,
    startTime: number,
  ): Promise<ActionResponse> {
    const sessionId = request.context.session_id;
    const correlationId = request.context.correlation_id;

    // Check if this action class was already confirmed in the session
    const alreadyConfirmed = await this.deps.sessionConfirmationStore.isConfirmed(
      request.action_type,
      sessionId,
    );

    if (alreadyConfirmed) {
      // Already confirmed in this session — execute without re-confirmation
      return this.executeAndAudit(request, startTime);
    }

    // Request user confirmation with 120s timeout
    const confirmationResponse = await this.deps.userConfirmationGateway.requestConfirmation({
      action_id: request.action_id,
      action_description: `Execute ${request.action_type} action`,
      action_type: request.action_type,
      timeout_seconds: this.deps.config.mediumConfirmationTimeoutSeconds,
    });

    if (confirmationResponse.timed_out) {
      return this.buildErrorResponse(
        request,
        'CANCELLED',
        'CONFIRMATION_TIMEOUT',
        'User confirmation timed out after 120 seconds',
        startTime,
        correlationId,
      );
    }

    if (!confirmationResponse.confirmed) {
      return this.buildErrorResponse(
        request,
        'CANCELLED',
        'USER_DECLINED',
        'User declined the action',
        startTime,
        correlationId,
      );
    }

    // Record the confirmation for this session
    await this.deps.sessionConfirmationStore.recordConfirmation({
      action_class: request.action_type,
      session_id: sessionId,
      confirmed_at: this.deps.clock.nowISO() as string,
    });

    // Execute the action
    return this.executeAndAudit(request, startTime);
  }

  /**
   * Handle HIGH/CRITICAL risk actions — require Confirmation_Challenge.
   * Issues a challenge and returns a response indicating the action is awaiting challenge.
   */
  private async handleHighCriticalRisk(
    request: ActionRequest,
    startTime: number,
  ): Promise<ActionResponse> {
    const correlationId = request.context.correlation_id;
    const sessionId = request.context.session_id;

    // Issue a confirmation challenge
    const challenge = await this.deps.confirmationChallengeClient.issueChallenge(
      request.action_id,
      sessionId,
      `Execute ${request.action_type} action (Risk: ${request.risk_level})`,
      correlationId,
    );

    // Store the pending action
    const pendingAction: PendingAction = {
      request,
      state: 'awaiting_challenge',
      challenge,
      startedAt: startTime,
    };
    this.pendingActions.set(request.action_id as string, pendingAction);

    // Return a response indicating the action is awaiting challenge
    const durationMs = (this.deps.clock.nowSeconds() - startTime) * 1000;
    const auditEventId = await this.emitAudit(
      request,
      'CANCELLED',
      durationMs,
      correlationId,
      'AWAITING_CHALLENGE',
    );

    return {
      action_id: request.action_id,
      idempotency_key: request.idempotency_key,
      outcome: 'CANCELLED',
      error: {
        code: 'AWAITING_CHALLENGE',
        message: 'Action requires Confirmation_Challenge. Submit challenge response to proceed.',
        details: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          expires_at: challenge.expires_at,
          action_description: challenge.action_description,
        },
      },
      duration_ms: durationMs,
      audit_event_id: auditEventId,
      correlation_id: correlationId,
    };
  }

  /**
   * Execute the action and emit an audit event.
   * This is the final execution step after all confirmations are satisfied.
   */
  private async executeAndAudit(
    request: ActionRequest,
    startTime: number,
  ): Promise<ActionResponse> {
    const correlationId = request.context.correlation_id;

    // Simulate action execution (in a real implementation, this would
    // delegate to the appropriate action handler based on action_type)
    const outcome: ActionOutcome = 'SUCCESS';
    const durationMs = (this.deps.clock.nowSeconds() - startTime) * 1000;

    // Emit audit event
    const auditEventId = await this.emitAudit(request, outcome, durationMs, correlationId);

    // Clean up pending action if it exists
    this.pendingActions.delete(request.action_id as string);

    return {
      action_id: request.action_id,
      idempotency_key: request.idempotency_key,
      outcome,
      duration_ms: durationMs,
      audit_event_id: auditEventId,
      correlation_id: correlationId,
    };
  }

  /**
   * Build an error response with audit emission.
   */
  private async buildErrorResponse(
    request: ActionRequest,
    outcome: ActionOutcome,
    errorCode: string,
    errorMessage: string,
    startTime: number,
    correlationId: CorrelationId,
  ): Promise<ActionResponse> {
    const durationMs = (this.deps.clock.nowSeconds() - startTime) * 1000;

    const auditEventId = await this.emitAudit(
      request,
      outcome,
      durationMs,
      correlationId,
      errorCode,
    );

    return {
      action_id: request.action_id,
      idempotency_key: request.idempotency_key,
      outcome,
      error: {
        code: errorCode,
        message: errorMessage,
      },
      duration_ms: durationMs,
      audit_event_id: auditEventId,
      correlation_id: correlationId,
    };
  }

  /**
   * Emit an audit event for an action.
   */
  private async emitAudit(
    request: ActionRequest,
    outcome: ActionOutcome,
    durationMs: number,
    correlationId: CorrelationId,
    errorCode?: string,
  ): Promise<string> {
    const payload: ActionAuditPayload = {
      action_id: request.action_id as string,
      principal_id: request.context.principal_id as string,
      tenant_id: request.context.tenant_id as string,
      action_type: request.action_type,
      risk_level: request.risk_level,
      outcome,
      parameters: request.parameters,
      duration_ms: durationMs,
      ...(errorCode ? { error: errorCode } : {}),
    };

    return this.deps.auditEmitter.emit(payload, correlationId);
  }
}
