/**
 * Property-based tests for risk-level confirmation logic.
 *
 * **Validates: Requirements 2.3, 2.4, 2.5, 2.10, 2.11**
 *
 * Property 1: Risk-Level Determines Confirmation Requirements — For any action
 *   with risk level SAFE or LOW, the action executor must execute immediately
 *   without requiring any user confirmation. The response must have outcome
 *   SUCCESS (assuming authorization passes).
 *
 * Property 2: Invalid Action Requests Are Rejected — For any action with risk
 *   level HIGH or CRITICAL, the action executor must issue a Confirmation_Challenge
 *   before execution. The initial response must indicate AWAITING_CHALLENGE with
 *   challenge details (challenge_id, nonce, expires_at).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
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

// ─── Mock Implementations ────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentSeconds = 1700000000;

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): ISOTimestamp {
    return new Date(this.currentSeconds * 1000).toISOString() as ISOTimestamp;
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
  async evaluate(_request: ActionRequest): Promise<AuthorizationDecision> {
    return { allowed: true, reason: 'Policy allows' };
  }
}

class MockConfirmationChallengeClient implements IConfirmationChallengeClient {
  readonly issuedChallenges: ConfirmationChallenge[] = [];
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
    return { valid: true };
  }
}

class MockSessionConfirmationStore implements ISessionConfirmationStore {
  async isConfirmed(_actionClass: string, _sessionId: SessionId): Promise<boolean> {
    return false;
  }

  async recordConfirmation(_confirmation: SessionConfirmation): Promise<void> {
    // no-op
  }
}

class MockUserConfirmationGateway implements IUserConfirmationGateway {
  readonly requests: UserConfirmationRequest[] = [];

  async requestConfirmation(request: UserConfirmationRequest): Promise<UserConfirmationResponse> {
    this.requests.push(request);
    return { confirmed: true, timed_out: false };
  }
}

class MockAuditEmitter implements IAuditEmitter {
  private eventCounter = 0;

  async emit(_payload: ActionAuditPayload, _correlationId: CorrelationId): Promise<string> {
    this.eventCounter++;
    return `audit-event-${this.eventCounter}`;
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for tenant IDs. */
const tenantIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `tenant-${s}` as TenantId);

/** Arbitrary for principal IDs. */
const principalIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `user-${s}` as PrincipalId);

/** Arbitrary for session IDs. */
const sessionIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `session-${s}` as SessionId);

/** Arbitrary for correlation IDs. */
const correlationIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `corr-${s}` as CorrelationId);

/** Arbitrary for action IDs. */
const actionIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `action-${s}` as ActionId);

/** Arbitrary for idempotency keys. */
const idempotencyKeyArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `idem-${s}` as IdempotencyKey);

/** Arbitrary for action types. */
const actionTypeArb = fc.constantFrom(
  'file.read', 'file.write', 'file.delete',
  'browser.navigate', 'browser.click',
  'system.shutdown', 'system.reboot',
  'data.export', 'data.purge',
  'network.request', 'process.start',
);

/** Arbitrary for SAFE or LOW risk levels. */
const safeLowRiskLevelArb = fc.constantFrom<RiskLevel>('SAFE', 'LOW');

/** Arbitrary for HIGH or CRITICAL risk levels. */
const highCriticalRiskLevelArb = fc.constantFrom<RiskLevel>('HIGH', 'CRITICAL');

/** Arbitrary for action parameters. */
const parametersArb = fc.dictionary(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 8 }),
  fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 3 },
);

/** Arbitrary for timeout seconds (valid range [1, 600]). */
const timeoutSecondsArb = fc.integer({ min: 1, max: 600 });

/** Arbitrary for a complete ActionRequest with a given risk level. */
function actionRequestArb(riskLevelArb: fc.Arbitrary<RiskLevel>): fc.Arbitrary<ActionRequest> {
  return fc.record({
    action_id: actionIdArb,
    idempotency_key: idempotencyKeyArb,
    risk_level: riskLevelArb,
    action_type: actionTypeArb,
    parameters: parametersArb,
    timeout_seconds: timeoutSecondsArb,
    context: fc.record({
      tenant_id: tenantIdArb,
      principal_id: principalIdArb,
      correlation_id: correlationIdArb,
      trace_context: fc.constant({ traceparent: '00-trace-id-span-id-01' }),
      session_id: sessionIdArb,
      roles: fc.constant(['End_User'] as readonly string[]),
      attributes: fc.constant({} as Readonly<Record<string, string>>),
      residency_region: fc.constantFrom('us-east-1', 'eu-west-1', 'ap-southeast-1'),
    }),
  });
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

function createExecutor(): {
  executor: ActionExecutor;
  confirmationGateway: MockUserConfirmationGateway;
  challengeClient: MockConfirmationChallengeClient;
} {
  const confirmationGateway = new MockUserConfirmationGateway();
  const challengeClient = new MockConfirmationChallengeClient();

  const deps: ActionExecutorDependencies = {
    authorizationClient: new MockAuthorizationClient(),
    confirmationChallengeClient: challengeClient,
    sessionConfirmationStore: new MockSessionConfirmationStore(),
    userConfirmationGateway: confirmationGateway,
    auditEmitter: new MockAuditEmitter(),
    clock: new MockClock(),
    idGenerator: new MockIdGenerator(),
    config: {
      defaultTimeoutSeconds: 60,
      mediumConfirmationTimeoutSeconds: 120,
      challengeTimeoutSeconds: 300,
    },
  };

  return { executor: new ActionExecutor(deps), confirmationGateway, challengeClient };
}

// ─── Property 1: Risk-Level Determines Confirmation Requirements ─────────────

describe('Property 1: Risk-Level Determines Confirmation Requirements', () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * For any action with risk level SAFE or LOW, the action executor must
   * execute immediately without requiring any user confirmation. The response
   * must have outcome SUCCESS (assuming authorization passes).
   */
  it('SAFE/LOW actions execute immediately with SUCCESS outcome without user confirmation', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(safeLowRiskLevelArb),
        async (request) => {
          const { executor, confirmationGateway, challengeClient } = createExecutor();

          const response = await executor.executeAction(request);

          // Must succeed without any confirmation
          expect(response.outcome).toBe('SUCCESS');
          // No user confirmation was requested
          expect(confirmationGateway.requests).toHaveLength(0);
          // No confirmation challenge was issued
          expect(challengeClient.issuedChallenges).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('SAFE/LOW actions return the correct action_id and idempotency_key', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(safeLowRiskLevelArb),
        async (request) => {
          const { executor } = createExecutor();

          const response = await executor.executeAction(request);

          expect(response.action_id).toBe(request.action_id);
          expect(response.idempotency_key).toBe(request.idempotency_key);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('SAFE/LOW actions return a valid audit_event_id and correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(safeLowRiskLevelArb),
        async (request) => {
          const { executor } = createExecutor();

          const response = await executor.executeAction(request);

          // Must have an audit event ID
          expect(response.audit_event_id).toBeTruthy();
          expect(typeof response.audit_event_id).toBe('string');
          // Must propagate the correlation_id
          expect(response.correlation_id).toBe(request.context.correlation_id);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: HIGH/CRITICAL Actions Require Confirmation_Challenge ────────

describe('Property 2: HIGH/CRITICAL Actions Require Confirmation_Challenge', () => {
  /**
   * **Validates: Requirements 2.5**
   *
   * For any action with risk level HIGH or CRITICAL, the action executor must
   * issue a Confirmation_Challenge before execution. The initial response must
   * indicate AWAITING_CHALLENGE with challenge details (challenge_id, nonce,
   * expires_at).
   */
  it('HIGH/CRITICAL actions issue a Confirmation_Challenge and return AWAITING_CHALLENGE', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(highCriticalRiskLevelArb),
        async (request) => {
          const { executor, challengeClient } = createExecutor();

          const response = await executor.executeAction(request);

          // Must not execute immediately — returns AWAITING_CHALLENGE
          expect(response.error?.code).toBe('AWAITING_CHALLENGE');
          // A challenge must have been issued
          expect(challengeClient.issuedChallenges).toHaveLength(1);
          // Challenge must be bound to the correct action
          expect(challengeClient.issuedChallenges[0].action_request_id).toBe(request.action_id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HIGH/CRITICAL response includes challenge_id, nonce, and expires_at in details', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(highCriticalRiskLevelArb),
        async (request) => {
          const { executor } = createExecutor();

          const response = await executor.executeAction(request);

          // Response must contain challenge details
          const details = response.error?.details as Record<string, unknown> | undefined;
          expect(details).toBeDefined();
          expect(details!.challenge_id).toBeTruthy();
          expect(typeof details!.challenge_id).toBe('string');
          expect(details!.nonce).toBeTruthy();
          expect(typeof details!.nonce).toBe('string');
          expect(details!.expires_at).toBeTruthy();
          expect(typeof details!.expires_at).toBe('string');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HIGH/CRITICAL actions do not request user confirmation gateway (only challenge)', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(highCriticalRiskLevelArb),
        async (request) => {
          const { executor, confirmationGateway } = createExecutor();

          await executor.executeAction(request);

          // Must NOT use the user confirmation gateway (that's for MEDIUM only)
          expect(confirmationGateway.requests).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HIGH/CRITICAL challenge is bound to the correct session_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb(highCriticalRiskLevelArb),
        async (request) => {
          const { executor, challengeClient } = createExecutor();

          await executor.executeAction(request);

          expect(challengeClient.issuedChallenges[0].session_id).toBe(
            request.context.session_id,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
