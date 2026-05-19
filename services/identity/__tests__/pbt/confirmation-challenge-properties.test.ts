/**
 * Property-based tests for Confirmation_Challenge validation and action binding.
 *
 * **Validates: Requirements 24.4, 24.5, 24.6**
 *
 * Property 12: Confirmation_Challenge Validation — accept only when all 4 conditions hold
 *   (nonce match, not expired, same session, not consumed)
 * Property 13: Confirmation_Challenge Action Binding — challenge bound to specific action_request_id
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@may/testing';
import { ConfirmationChallengeService } from '../../src/confirmation-challenge-service.js';
import { InMemoryChallengeStore, InMemoryLockoutStore } from '../../src/in-memory-challenge-store.js';
import type { IClock, IIdGenerator } from '../../src/interfaces/index.js';
import type {
  INonceGenerator,
  IChallengeAuditEmitter,
  ChallengeAuditPayload,
  ConfirmationChallengeConfig,
} from '../../src/interfaces/confirmation-challenge.js';
import type {
  ActionId,
  SessionId,
  CorrelationId,
  ChallengeId,
  ISOTimestamp,
} from '@may/types';
import type { ChallengeInputMethod } from '@may/types';

// ─── Stub Implementations ────────────────────────────────────────────────────

class StubClock implements IClock {
  constructor(private currentSeconds: number = 1700000000) {}

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

class StubIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `challenge-id-${this.counter}`;
  }
}

class StubNonceGenerator implements INonceGenerator {
  private nextNonce: string = 'default-nonce';

  generate(): string {
    return this.nextNonce;
  }

  setNext(nonce: string): void {
    this.nextNonce = nonce;
  }
}

class StubAuditEmitter implements IChallengeAuditEmitter {
  readonly events: ChallengeAuditPayload[] = [];
  private counter = 0;

  async emit(payload: ChallengeAuditPayload, _correlationId: CorrelationId): Promise<string> {
    this.events.push(payload);
    this.counter++;
    return `audit-${this.counter}`;
  }
}

// ─── Helper: Create service with fresh dependencies ──────────────────────────

function createService(clockSeconds: number = 1700000000) {
  const clock = new StubClock(clockSeconds);
  const challengeStore = new InMemoryChallengeStore();
  const lockoutStore = new InMemoryLockoutStore(clock);
  const nonceGenerator = new StubNonceGenerator();
  const auditEmitter = new StubAuditEmitter();
  const idGenerator = new StubIdGenerator();

  const config: ConfirmationChallengeConfig = {
    expirySeconds: 60,
    maxFailuresBeforeLockout: 5,
    lockoutDurationSeconds: 300,
  };

  const service = new ConfirmationChallengeService({
    challengeStore,
    lockoutStore,
    nonceGenerator,
    auditEmitter,
    clock,
    idGenerator,
    config,
  });

  return { service, clock, challengeStore, lockoutStore, nonceGenerator, auditEmitter, idGenerator, config };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for a UUID-like string. */
const uuidArb = fc.uuid();

/** Arbitrary for action_request_id. */
const actionIdArb = uuidArb.map((id) => id as ActionId);

/** Arbitrary for session_id. */
const sessionIdArb = uuidArb.map((id) => id as SessionId);

/** Arbitrary for correlation_id. */
const correlationIdArb = uuidArb.map((id) => id as CorrelationId);

/** Arbitrary for a nonce string (hex-like). */
const nonceArb = fc.hexaString({ minLength: 16, maxLength: 64 });

/** Arbitrary for action description. */
const actionDescriptionArb = fc.string({ minLength: 1, maxLength: 100 });

/** Arbitrary for the 4 boolean conditions that determine validation outcome. */
const validationConditionsArb = fc.record({
  nonceMatch: fc.boolean(),
  notExpired: fc.boolean(),
  sameSession: fc.boolean(),
  notConsumed: fc.boolean(),
});

// ─── Property 12: Confirmation_Challenge Validation ──────────────────────────

describe('Property 12: Confirmation_Challenge Validation', () => {
  /**
   * **Validates: Requirements 24.4, 24.5**
   *
   * For ALL 16 combinations of (nonceMatch, notExpired, sameSession, notConsumed),
   * validation returns valid=true ONLY when ALL four conditions hold simultaneously.
   * If ANY single condition fails, valid MUST be false.
   */
  it('accepts only when all 4 conditions hold (nonce match, not expired, same session, not consumed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        validationConditionsArb,
        actionIdArb,
        sessionIdArb,
        correlationIdArb,
        nonceArb,
        actionDescriptionArb,
        async (conditions, actionId, sessionId, correlationId, nonce, actionDescription) => {
          const { service, clock, nonceGenerator, challengeStore } = createService();

          // Set the nonce that will be generated
          nonceGenerator.setNext(nonce);

          // Issue a challenge
          const challenge = await service.issueChallenge({
            action_request_id: actionId,
            session_id: sessionId,
            action_description: actionDescription,
            correlation_id: correlationId,
          });

          // Set up conditions for validation:

          // Condition 2: notExpired — if false, advance clock past expiry
          if (!conditions.notExpired) {
            clock.advance(61); // Challenge expires after 60s
          }

          // Condition 4: notConsumed — if false, mark the challenge as consumed
          if (!conditions.notConsumed) {
            await challengeStore.markConsumed(challenge.challenge_id);
          }

          // Condition 1: nonceMatch — use correct or wrong nonce
          const responseNonce = conditions.nonceMatch ? nonce : nonce + '-wrong';

          // Condition 3: sameSession — use correct or different session
          const responseSessionId = conditions.sameSession
            ? sessionId
            : (`different-session-${sessionId}` as SessionId);

          // Validate the challenge
          const result = await service.validateChallenge({
            response: {
              challenge_id: challenge.challenge_id,
              nonce: responseNonce,
              session_id: responseSessionId,
              input_method: 'hud_input' as ChallengeInputMethod,
            },
            correlation_id: correlationId,
          });

          const allConditionsHold =
            conditions.nonceMatch &&
            conditions.notExpired &&
            conditions.sameSession &&
            conditions.notConsumed;

          if (allConditionsHold) {
            expect(result.valid).toBe(true);
          } else {
            expect(result.valid).toBe(false);
            expect(result.rejection_reason).toBeDefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('each individual failing condition produces the correct rejection reason', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionIdArb,
        sessionIdArb,
        correlationIdArb,
        nonceArb,
        actionDescriptionArb,
        fc.constantFrom('nonceMatch', 'notExpired', 'sameSession', 'notConsumed') as fc.Arbitrary<
          'nonceMatch' | 'notExpired' | 'sameSession' | 'notConsumed'
        >,
        async (actionId, sessionId, correlationId, nonce, actionDescription, failingCondition) => {
          const { service, clock, nonceGenerator, challengeStore } = createService();

          nonceGenerator.setNext(nonce);

          // Issue a challenge
          const challenge = await service.issueChallenge({
            action_request_id: actionId,
            session_id: sessionId,
            action_description: actionDescription,
            correlation_id: correlationId,
          });

          // Only fail the specified condition, keep all others passing
          let responseNonce = nonce;
          let responseSessionId: SessionId = sessionId;

          switch (failingCondition) {
            case 'nonceMatch':
              responseNonce = nonce + '-wrong';
              break;
            case 'notExpired':
              clock.advance(61);
              break;
            case 'sameSession':
              responseSessionId = `different-session-${sessionId}` as SessionId;
              break;
            case 'notConsumed':
              await challengeStore.markConsumed(challenge.challenge_id);
              break;
          }

          const result = await service.validateChallenge({
            response: {
              challenge_id: challenge.challenge_id,
              nonce: responseNonce,
              session_id: responseSessionId,
              input_method: 'hud_input' as ChallengeInputMethod,
            },
            correlation_id: correlationId,
          });

          expect(result.valid).toBe(false);

          // Verify the correct rejection reason is returned
          const expectedReasons: Record<string, string> = {
            nonceMatch: 'NONCE_MISMATCH',
            notExpired: 'EXPIRED',
            sameSession: 'SESSION_MISMATCH',
            notConsumed: 'ALREADY_CONSUMED',
          };

          expect(result.rejection_reason).toBe(expectedReasons[failingCondition]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 13: Confirmation_Challenge Action Binding ──────────────────────

describe('Property 13: Confirmation_Challenge Action Binding', () => {
  /**
   * **Validates: Requirements 24.6**
   *
   * For ANY action_request_id, when a challenge is issued and then successfully
   * validated, the returned action_request_id in the validation result MUST match
   * the one used during issuance. Different challenges issued for different actions
   * must remain independently bound.
   */
  it('successful validation returns the exact action_request_id used during issuance', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionIdArb,
        sessionIdArb,
        correlationIdArb,
        nonceArb,
        actionDescriptionArb,
        async (actionId, sessionId, correlationId, nonce, actionDescription) => {
          const { service, nonceGenerator } = createService();

          nonceGenerator.setNext(nonce);

          // Issue a challenge bound to a specific action_request_id
          const challenge = await service.issueChallenge({
            action_request_id: actionId,
            session_id: sessionId,
            action_description: actionDescription,
            correlation_id: correlationId,
          });

          // Validate with all correct conditions
          const result = await service.validateChallenge({
            response: {
              challenge_id: challenge.challenge_id,
              nonce,
              session_id: sessionId,
              input_method: 'hud_input' as ChallengeInputMethod,
            },
            correlation_id: correlationId,
          });

          // The result must be valid and return the exact action_request_id
          expect(result.valid).toBe(true);
          expect(result.action_request_id).toBe(actionId);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('different challenges for different actions remain independently bound', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionIdArb,
        actionIdArb.filter((id) => id.length > 0),
        sessionIdArb,
        correlationIdArb,
        nonceArb,
        nonceArb.filter((n) => n.length > 0),
        actionDescriptionArb,
        async (actionId1, actionId2, sessionId, correlationId, nonce1, nonce2, actionDescription) => {
          // Ensure the two action IDs are different
          if (actionId1 === actionId2) return; // skip if same (unlikely with UUIDs)

          const { service, nonceGenerator } = createService();

          // Issue challenge 1 for action 1
          nonceGenerator.setNext(nonce1);
          const challenge1 = await service.issueChallenge({
            action_request_id: actionId1,
            session_id: sessionId,
            action_description: actionDescription,
            correlation_id: correlationId,
          });

          // Issue challenge 2 for action 2
          nonceGenerator.setNext(nonce2);
          const challenge2 = await service.issueChallenge({
            action_request_id: actionId2,
            session_id: sessionId,
            action_description: actionDescription,
            correlation_id: correlationId,
          });

          // Validate challenge 1 — should return action 1
          const result1 = await service.validateChallenge({
            response: {
              challenge_id: challenge1.challenge_id,
              nonce: nonce1,
              session_id: sessionId,
              input_method: 'hud_input' as ChallengeInputMethod,
            },
            correlation_id: correlationId,
          });

          expect(result1.valid).toBe(true);
          expect(result1.action_request_id).toBe(actionId1);
          // Must NOT return the other action's ID
          if (actionId1 !== actionId2) {
            expect(result1.action_request_id).not.toBe(actionId2);
          }

          // Validate challenge 2 — should return action 2
          const result2 = await service.validateChallenge({
            response: {
              challenge_id: challenge2.challenge_id,
              nonce: nonce2,
              session_id: sessionId,
              input_method: 'hud_input' as ChallengeInputMethod,
            },
            correlation_id: correlationId,
          });

          expect(result2.valid).toBe(true);
          expect(result2.action_request_id).toBe(actionId2);
          // Must NOT return the other action's ID
          if (actionId1 !== actionId2) {
            expect(result2.action_request_id).not.toBe(actionId1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
