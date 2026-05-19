/**
 * Unit tests for ActionExecutor service.
 *
 * Verifies:
 * - Risk_Level validation (Requirement 2.1, 2.10)
 * - Authorization enforcement (Requirement 2.2, 2.11)
 * - SAFE/LOW execution without confirmation (Requirement 2.3)
 * - MEDIUM risk session-level confirmation (Requirement 2.4)
 * - HIGH/CRITICAL Confirmation_Challenge requirement (Requirement 2.5)
 * - Audit event emission for all outcomes
 * - Action lifecycle management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ActionExecutor } from '../src/action-executor.js';
import type {
  IAuthorizationClient,
  IConfirmationChallengeClient,
  ISessionConfirmationStore,
  IAuditEmitter,
  IUserConfirmationGateway,
  ActionExecutorConfig,
  ActionExecutorDependencies,
  ActionAuditPayload,
  AuthorizationDecision,
  SessionConfirmation,
  UserConfirmationRequest,
  UserConfirmationResponse,
  IClock,
  IIdGenerator,
} from '../src/interfaces/index.js';
import type {
  ActionRequest,
  RiskLevel,
  ActionId,
  IdempotencyKey,
  CorrelationId,
  TenantId,
  PrincipalId,
  SessionId,
  ISOTimestamp,
  ConfirmationChallenge,
  ChallengeId,
  ChallengeResponse,
} from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeActionRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action_id: 'action-001' as ActionId,
    idempotency_key: 'idem-001' as IdempotencyKey,
    risk_level: 'LOW' as RiskLevel,
    action_type: 'file.read',
    parameters: { path: '/tmp/test.txt' },
    timeout_seconds: 60,
    context: {
      tenant_id: 'tenant-1' as TenantId,
      principal_id: 'user-1' as PrincipalId,
      correlation_id: 'corr-1' as CorrelationId,
      trace_context: { traceparent: '00-trace-id-span-id-01' },
      session_id: 'session-1' as SessionId,
      roles: ['End_User'],
      attributes: {},
      residency_region: 'us-east-1',
    },
    ...overrides,
  };
}

// ─── Mock Implementations ────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentSeconds = 1700000000;

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): ISOTimestamp {
    return new Date(this.currentSeconds * 1000).toISOString() as ISOTimestamp;
  }

  advance(seconds: number): void {
    this.currentSeconds += seconds;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `uuid-${this.counter}`;
  }
}

class MockAuthorizationClient implements IAuthorizationClient {
  private decision: AuthorizationDecision = { allowed: true, reason: 'Policy allows' };

  async evaluate(_request: ActionRequest): Promise<AuthorizationDecision> {
    return this.decision;
  }

  setDecision(decision: AuthorizationDecision): void {
    this.decision = decision;
  }
}

class MockConfirmationChallengeClient implements IConfirmationChallengeClient {
  readonly issuedChallenges: ConfirmationChallenge[] = [];
  private validateResult: { valid: boolean; rejection_reason?: string } = { valid: true };
  private challengeCounter = 0;

  async issueChallenge(
    actionId: ActionId,
    sessionId: SessionId,
    actionDescription: string,
    _correlationId: CorrelationId,
  ): Promise<ConfirmationChallenge> {
    this.challengeCounter++;
    const challenge: ConfirmationChallenge = {
      challenge_id: `challenge-${this.challengeCounter}` as ChallengeId,
      nonce: `nonce-${this.challengeCounter}`,
      action_request_id: actionId,
      session_id: sessionId,
      expires_at: new Date(Date.now() + 60000).toISOString() as ISOTimestamp,
      action_description: actionDescription,
      consumed: false,
    };
    this.issuedChallenges.push(challenge);
    return challenge;
  }

  async validateChallenge(
    _response: ChallengeResponse,
    _correlationId: CorrelationId,
  ): Promise<{ valid: boolean; rejection_reason?: string }> {
    return this.validateResult;
  }

  setValidateResult(result: { valid: boolean; rejection_reason?: string }): void {
    this.validateResult = result;
  }
}

class MockSessionConfirmationStore implements ISessionConfirmationStore {
  private confirmations: Map<string, SessionConfirmation> = new Map();

  async isConfirmed(actionClass: string, sessionId: SessionId): Promise<boolean> {
    const key = `${sessionId}:${actionClass}`;
    return this.confirmations.has(key);
  }

  async recordConfirmation(confirmation: SessionConfirmation): Promise<void> {
    const key = `${confirmation.session_id}:${confirmation.action_class}`;
    this.confirmations.set(key, confirmation);
  }

  getConfirmations(): Map<string, SessionConfirmation> {
    return this.confirmations;
  }
}

class MockUserConfirmationGateway implements IUserConfirmationGateway {
  private response: UserConfirmationResponse = { confirmed: true, timed_out: false };
  readonly requests: UserConfirmationRequest[] = [];

  async requestConfirmation(request: UserConfirmationRequest): Promise<UserConfirmationResponse> {
    this.requests.push(request);
    return this.response;
  }

  setResponse(response: UserConfirmationResponse): void {
    this.response = response;
  }
}

class MockAuditEmitter implements IAuditEmitter {
  readonly emittedEvents: Array<{
    payload: ActionAuditPayload;
    correlationId: CorrelationId;
  }> = [];
  private eventCounter = 0;

  async emit(payload: ActionAuditPayload, correlationId: CorrelationId): Promise<string> {
    this.eventCounter++;
    const eventId = `audit-event-${this.eventCounter}`;
    this.emittedEvents.push({ payload, correlationId });
    return eventId;
  }

  get lastEvent() {
    return this.emittedEvents[this.emittedEvents.length - 1];
  }

  clear(): void {
    this.emittedEvents.length = 0;
    this.eventCounter = 0;
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('ActionExecutor', () => {
  let executor: ActionExecutor;
  let authClient: MockAuthorizationClient;
  let challengeClient: MockConfirmationChallengeClient;
  let sessionStore: MockSessionConfirmationStore;
  let confirmationGateway: MockUserConfirmationGateway;
  let auditEmitter: MockAuditEmitter;
  let clock: MockClock;
  let idGenerator: MockIdGenerator;
  let config: ActionExecutorConfig;

  beforeEach(() => {
    authClient = new MockAuthorizationClient();
    challengeClient = new MockConfirmationChallengeClient();
    sessionStore = new MockSessionConfirmationStore();
    confirmationGateway = new MockUserConfirmationGateway();
    auditEmitter = new MockAuditEmitter();
    clock = new MockClock();
    idGenerator = new MockIdGenerator();
    config = {
      defaultTimeoutSeconds: 60,
      mediumConfirmationTimeoutSeconds: 120,
      challengeTimeoutSeconds: 300,
    };

    const deps: ActionExecutorDependencies = {
      authorizationClient: authClient,
      confirmationChallengeClient: challengeClient,
      sessionConfirmationStore: sessionStore,
      userConfirmationGateway: confirmationGateway,
      auditEmitter,
      clock,
      idGenerator,
      config,
    };

    executor = new ActionExecutor(deps);
  });

  // ─── Risk_Level Validation (Requirement 2.1, 2.10) ─────────────────────────

  describe('Risk_Level validation', () => {
    it('should reject request with missing risk_level', async () => {
      const request = makeActionRequest({ risk_level: '' as RiskLevel });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('DENIED');
      expect(response.error?.code).toBe('VALIDATION_ERROR');
      expect(response.error?.message).toContain('Risk_Level');
    });

    it('should reject request with invalid risk_level', async () => {
      const request = makeActionRequest({ risk_level: 'INVALID' as RiskLevel });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('DENIED');
      expect(response.error?.code).toBe('VALIDATION_ERROR');
      expect(response.error?.message).toContain('INVALID');
    });

    it('should emit audit event with DENIED outcome for invalid risk_level', async () => {
      const request = makeActionRequest({ risk_level: 'BOGUS' as RiskLevel });

      await executor.executeAction(request);

      expect(auditEmitter.emittedEvents).toHaveLength(1);
      expect(auditEmitter.lastEvent!.payload.outcome).toBe('DENIED');
    });

    it('should accept all valid risk levels', async () => {
      const validLevels: RiskLevel[] = ['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

      for (const level of validLevels) {
        auditEmitter.clear();
        const request = makeActionRequest({
          risk_level: level,
          action_id: `action-${level}` as ActionId,
        });

        const response = await executor.executeAction(request);

        // Should not get a VALIDATION_ERROR
        if (response.error) {
          expect(response.error.code).not.toBe('VALIDATION_ERROR');
        }
      }
    });
  });

  // ─── Authorization Enforcement (Requirement 2.2, 2.11) ─────────────────────

  describe('Authorization enforcement', () => {
    it('should reject unauthorized actions with DENIED outcome', async () => {
      authClient.setDecision({ allowed: false, reason: 'Policy denies file.delete for End_User' });
      const request = makeActionRequest({ action_type: 'file.delete' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('DENIED');
      expect(response.error?.code).toBe('AUTHORIZATION_DENIED');
      expect(response.error?.message).toContain('Policy denies');
    });

    it('should emit audit event with DENIED outcome for unauthorized actions', async () => {
      authClient.setDecision({ allowed: false, reason: 'No permission' });
      const request = makeActionRequest();

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.outcome).toBe('DENIED');
      expect(auditEmitter.lastEvent!.payload.action_type).toBe('file.read');
    });

    it('should include principal_id in audit event', async () => {
      authClient.setDecision({ allowed: false, reason: 'Denied' });
      const request = makeActionRequest();

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.principal_id).toBe('user-1');
    });

    it('should include correlation_id in audit event', async () => {
      authClient.setDecision({ allowed: false, reason: 'Denied' });
      const request = makeActionRequest();

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.correlationId).toBe('corr-1');
    });
  });

  // ─── SAFE/LOW Execution Without Confirmation (Requirement 2.3) ─────────────

  describe('SAFE/LOW execution without confirmation', () => {
    it('should execute SAFE actions immediately without confirmation', async () => {
      const request = makeActionRequest({ risk_level: 'SAFE' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('SUCCESS');
      expect(confirmationGateway.requests).toHaveLength(0);
    });

    it('should execute LOW actions immediately without confirmation', async () => {
      const request = makeActionRequest({ risk_level: 'LOW' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('SUCCESS');
      expect(confirmationGateway.requests).toHaveLength(0);
    });

    it('should emit audit event with SUCCESS outcome for SAFE actions', async () => {
      const request = makeActionRequest({ risk_level: 'SAFE' });

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.outcome).toBe('SUCCESS');
      expect(auditEmitter.lastEvent!.payload.risk_level).toBe('SAFE');
    });

    it('should return correct action_id and idempotency_key', async () => {
      const request = makeActionRequest({
        risk_level: 'LOW',
        action_id: 'my-action' as ActionId,
        idempotency_key: 'my-key' as IdempotencyKey,
      });

      const response = await executor.executeAction(request);

      expect(response.action_id).toBe('my-action');
      expect(response.idempotency_key).toBe('my-key');
    });

    it('should not issue confirmation challenge for SAFE/LOW', async () => {
      const request = makeActionRequest({ risk_level: 'SAFE' });

      await executor.executeAction(request);

      expect(challengeClient.issuedChallenges).toHaveLength(0);
    });
  });

  // ─── MEDIUM Risk Session-Level Confirmation (Requirement 2.4) ──────────────

  describe('MEDIUM risk session-level confirmation', () => {
    it('should request user confirmation for MEDIUM risk actions', async () => {
      const request = makeActionRequest({
        risk_level: 'MEDIUM',
        action_type: 'file.delete',
      });

      await executor.executeAction(request);

      expect(confirmationGateway.requests).toHaveLength(1);
      expect(confirmationGateway.requests[0].action_type).toBe('file.delete');
    });

    it('should execute after user confirms', async () => {
      confirmationGateway.setResponse({ confirmed: true, timed_out: false });
      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('SUCCESS');
    });

    it('should cancel when user declines', async () => {
      confirmationGateway.setResponse({ confirmed: false, timed_out: false });
      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('CANCELLED');
      expect(response.error?.code).toBe('USER_DECLINED');
    });

    it('should cancel with CANCELLED outcome on timeout (120s)', async () => {
      confirmationGateway.setResponse({ confirmed: false, timed_out: true });
      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('CANCELLED');
      expect(response.error?.code).toBe('CONFIRMATION_TIMEOUT');
    });

    it('should pass 120s timeout to confirmation gateway', async () => {
      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      await executor.executeAction(request);

      expect(confirmationGateway.requests[0].timeout_seconds).toBe(120);
    });

    it('should skip confirmation if action class already confirmed in session', async () => {
      // First execution — requires confirmation
      confirmationGateway.setResponse({ confirmed: true, timed_out: false });
      const request1 = makeActionRequest({
        risk_level: 'MEDIUM',
        action_type: 'file.delete',
        action_id: 'action-1' as ActionId,
      });
      await executor.executeAction(request1);

      // Second execution of same action class — should skip confirmation
      const request2 = makeActionRequest({
        risk_level: 'MEDIUM',
        action_type: 'file.delete',
        action_id: 'action-2' as ActionId,
      });
      const response = await executor.executeAction(request2);

      expect(response.outcome).toBe('SUCCESS');
      // Only one confirmation request (from the first call)
      expect(confirmationGateway.requests).toHaveLength(1);
    });

    it('should require confirmation for different action classes', async () => {
      confirmationGateway.setResponse({ confirmed: true, timed_out: false });

      // Confirm file.delete
      const request1 = makeActionRequest({
        risk_level: 'MEDIUM',
        action_type: 'file.delete',
        action_id: 'action-1' as ActionId,
      });
      await executor.executeAction(request1);

      // file.write should still require confirmation
      const request2 = makeActionRequest({
        risk_level: 'MEDIUM',
        action_type: 'file.write',
        action_id: 'action-2' as ActionId,
      });
      await executor.executeAction(request2);

      expect(confirmationGateway.requests).toHaveLength(2);
    });

    it('should record session confirmation after user confirms', async () => {
      confirmationGateway.setResponse({ confirmed: true, timed_out: false });
      const request = makeActionRequest({
        risk_level: 'MEDIUM',
        action_type: 'browser.navigate',
      });

      await executor.executeAction(request);

      const isConfirmed = await sessionStore.isConfirmed(
        'browser.navigate',
        'session-1' as SessionId,
      );
      expect(isConfirmed).toBe(true);
    });
  });

  // ─── HIGH/CRITICAL Confirmation_Challenge (Requirement 2.5) ────────────────

  describe('HIGH/CRITICAL Confirmation_Challenge', () => {
    it('should issue a confirmation challenge for HIGH risk actions', async () => {
      const request = makeActionRequest({
        risk_level: 'HIGH',
        action_type: 'system.shutdown',
      });

      await executor.executeAction(request);

      expect(challengeClient.issuedChallenges).toHaveLength(1);
      expect(challengeClient.issuedChallenges[0].action_request_id).toBe(request.action_id);
    });

    it('should issue a confirmation challenge for CRITICAL risk actions', async () => {
      const request = makeActionRequest({
        risk_level: 'CRITICAL',
        action_type: 'data.purge',
      });

      await executor.executeAction(request);

      expect(challengeClient.issuedChallenges).toHaveLength(1);
    });

    it('should return AWAITING_CHALLENGE response for HIGH/CRITICAL', async () => {
      const request = makeActionRequest({ risk_level: 'HIGH' });

      const response = await executor.executeAction(request);

      expect(response.error?.code).toBe('AWAITING_CHALLENGE');
      expect(response.error?.details).toHaveProperty('challenge_id');
      expect(response.error?.details).toHaveProperty('nonce');
      expect(response.error?.details).toHaveProperty('expires_at');
    });

    it('should execute action after valid challenge response', async () => {
      const request = makeActionRequest({
        risk_level: 'HIGH',
        action_id: 'high-action-1' as ActionId,
      });

      // First call — issues challenge
      const initialResponse = await executor.executeAction(request);
      const challengeId = (initialResponse.error?.details as Record<string, unknown>)?.challenge_id as string;
      const nonce = (initialResponse.error?.details as Record<string, unknown>)?.nonce as string;

      // Submit valid challenge response
      challengeClient.setValidateResult({ valid: true });
      const challengeResponse: ChallengeResponse = {
        challenge_id: challengeId as ChallengeId,
        nonce,
        session_id: 'session-1' as SessionId,
        input_method: 'hud_input',
      };

      const finalResponse = await executor.submitChallengeResponse(
        'high-action-1' as ActionId,
        challengeResponse,
      );

      expect(finalResponse.outcome).toBe('SUCCESS');
    });

    it('should deny action on invalid challenge response', async () => {
      const request = makeActionRequest({
        risk_level: 'HIGH',
        action_id: 'high-action-2' as ActionId,
      });

      await executor.executeAction(request);

      // Submit invalid challenge response
      challengeClient.setValidateResult({ valid: false, rejection_reason: 'NONCE_MISMATCH' });
      const challengeResponse: ChallengeResponse = {
        challenge_id: 'challenge-1' as ChallengeId,
        nonce: 'wrong-nonce',
        session_id: 'session-1' as SessionId,
        input_method: 'hud_input',
      };

      const finalResponse = await executor.submitChallengeResponse(
        'high-action-2' as ActionId,
        challengeResponse,
      );

      expect(finalResponse.outcome).toBe('DENIED');
      expect(finalResponse.error?.code).toBe('CHALLENGE_VALIDATION_FAILED');
    });

    it('should not request user confirmation gateway for HIGH/CRITICAL', async () => {
      const request = makeActionRequest({ risk_level: 'HIGH' });

      await executor.executeAction(request);

      expect(confirmationGateway.requests).toHaveLength(0);
    });

    it('should bind challenge to the correct action_id', async () => {
      const request = makeActionRequest({
        risk_level: 'CRITICAL',
        action_id: 'critical-action-99' as ActionId,
      });

      await executor.executeAction(request);

      expect(challengeClient.issuedChallenges[0].action_request_id).toBe('critical-action-99');
    });

    it('should bind challenge to the correct session_id', async () => {
      const request = makeActionRequest({ risk_level: 'HIGH' });

      await executor.executeAction(request);

      expect(challengeClient.issuedChallenges[0].session_id).toBe('session-1');
    });
  });

  // ─── submitChallengeResponse Edge Cases ────────────────────────────────────

  describe('submitChallengeResponse edge cases', () => {
    it('should return DENIED for non-existent action ID', async () => {
      const challengeResponse: ChallengeResponse = {
        challenge_id: 'challenge-x' as ChallengeId,
        nonce: 'nonce-x',
        session_id: 'session-1' as SessionId,
        input_method: 'hud_input',
      };

      const response = await executor.submitChallengeResponse(
        'nonexistent-action' as ActionId,
        challengeResponse,
      );

      expect(response.outcome).toBe('DENIED');
      expect(response.error?.code).toBe('ACTION_NOT_FOUND');
    });

    it('should return DENIED if action is not in awaiting_challenge state', async () => {
      // Execute a LOW action (goes straight to completed)
      const request = makeActionRequest({
        risk_level: 'LOW',
        action_id: 'low-action' as ActionId,
      });
      await executor.executeAction(request);

      // Try to submit a challenge response for it
      const challengeResponse: ChallengeResponse = {
        challenge_id: 'challenge-x' as ChallengeId,
        nonce: 'nonce-x',
        session_id: 'session-1' as SessionId,
        input_method: 'hud_input',
      };

      const response = await executor.submitChallengeResponse(
        'low-action' as ActionId,
        challengeResponse,
      );

      // Action was already completed and removed from pending, so it's not found
      expect(response.outcome).toBe('DENIED');
      expect(response.error?.code).toBe('ACTION_NOT_FOUND');
    });
  });

  // ─── Audit Event Emission ──────────────────────────────────────────────────

  describe('Audit event emission', () => {
    it('should emit audit event for successful SAFE action', async () => {
      const request = makeActionRequest({ risk_level: 'SAFE', action_type: 'file.read' });

      const response = await executor.executeAction(request);

      expect(auditEmitter.emittedEvents).toHaveLength(1);
      const event = auditEmitter.lastEvent!;
      expect(event.payload.action_id).toBe('action-001');
      expect(event.payload.outcome).toBe('SUCCESS');
      expect(event.payload.risk_level).toBe('SAFE');
      expect(event.payload.action_type).toBe('file.read');
      expect(response.audit_event_id).toBe('audit-event-1');
    });

    it('should emit audit event for DENIED (validation error)', async () => {
      const request = makeActionRequest({ risk_level: 'INVALID' as RiskLevel });

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.outcome).toBe('DENIED');
    });

    it('should emit audit event for DENIED (authorization)', async () => {
      authClient.setDecision({ allowed: false, reason: 'No access' });
      const request = makeActionRequest();

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.outcome).toBe('DENIED');
    });

    it('should emit audit event for CANCELLED (user declined)', async () => {
      confirmationGateway.setResponse({ confirmed: false, timed_out: false });
      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.outcome).toBe('CANCELLED');
    });

    it('should emit audit event for CANCELLED (timeout)', async () => {
      confirmationGateway.setResponse({ confirmed: false, timed_out: true });
      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.outcome).toBe('CANCELLED');
    });

    it('should include tenant_id in audit event', async () => {
      const request = makeActionRequest({ risk_level: 'LOW' });

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.tenant_id).toBe('tenant-1');
    });

    it('should include parameters in audit event', async () => {
      const request = makeActionRequest({
        risk_level: 'LOW',
        parameters: { file: '/etc/hosts' },
      });

      await executor.executeAction(request);

      expect(auditEmitter.lastEvent!.payload.parameters).toEqual({ file: '/etc/hosts' });
    });

    it('should return audit_event_id in response', async () => {
      const request = makeActionRequest({ risk_level: 'LOW' });

      const response = await executor.executeAction(request);

      expect(response.audit_event_id).toMatch(/^audit-event-/);
    });

    it('should return correlation_id in response', async () => {
      const request = makeActionRequest({ risk_level: 'LOW' });

      const response = await executor.executeAction(request);

      expect(response.correlation_id).toBe('corr-1');
    });
  });

  // ─── Action Lifecycle ──────────────────────────────────────────────────────

  describe('Action lifecycle', () => {
    it('should track duration_ms for executed actions', async () => {
      const request = makeActionRequest({ risk_level: 'LOW' });

      const response = await executor.executeAction(request);

      // Clock doesn't advance in this test, so duration is 0
      expect(response.duration_ms).toBe(0);
    });

    it('should track duration_ms across confirmation wait', async () => {
      // Advance clock during confirmation
      const originalRequestConfirmation = confirmationGateway.requestConfirmation.bind(confirmationGateway);
      confirmationGateway.requestConfirmation = async (req: UserConfirmationRequest) => {
        clock.advance(5); // 5 seconds for user to confirm
        return originalRequestConfirmation(req);
      };

      const request = makeActionRequest({ risk_level: 'MEDIUM' });

      const response = await executor.executeAction(request);

      expect(response.outcome).toBe('SUCCESS');
      expect(response.duration_ms).toBe(5000); // 5 seconds * 1000
    });

    it('should handle multiple concurrent actions independently', async () => {
      const request1 = makeActionRequest({
        risk_level: 'HIGH',
        action_id: 'concurrent-1' as ActionId,
        action_type: 'system.reboot',
      });
      const request2 = makeActionRequest({
        risk_level: 'HIGH',
        action_id: 'concurrent-2' as ActionId,
        action_type: 'data.export',
      });

      // Both issue challenges
      await executor.executeAction(request1);
      await executor.executeAction(request2);

      expect(challengeClient.issuedChallenges).toHaveLength(2);

      // Submit challenge for action 2 only
      challengeClient.setValidateResult({ valid: true });
      const response2 = await executor.submitChallengeResponse(
        'concurrent-2' as ActionId,
        {
          challenge_id: 'challenge-2' as ChallengeId,
          nonce: 'nonce-2',
          session_id: 'session-1' as SessionId,
          input_method: 'hud_input',
        },
      );

      expect(response2.outcome).toBe('SUCCESS');
      expect(response2.action_id).toBe('concurrent-2');
    });
  });
});
