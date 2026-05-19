/**
 * Unit tests for ConfirmationChallengeService.
 *
 * Verifies:
 * - Challenge issuance with nonce, 60s expiry, action binding (Requirement 24.1)
 * - Validation: nonce match, not expired, same session, not consumed (Requirement 24.4)
 * - Rejection with invalidation, audit, and lockout (Requirement 24.5)
 * - Action binding (Requirement 24.6)
 * - Progressive lockout behavior
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfirmationChallengeService } from '../src/confirmation-challenge-service.js';
import { InMemoryChallengeStore, InMemoryLockoutStore } from '../src/in-memory-challenge-store.js';
import type {
  IClock,
  IIdGenerator,
  IChallengeAuditEmitter,
  INonceGenerator,
  ChallengeAuditPayload,
  ConfirmationChallengeConfig,
  IssueChallengeRequest,
  ValidateChallengeRequest,
} from '../src/interfaces/index.js';
import type {
  ActionId,
  SessionId,
  ChallengeId,
  CorrelationId,
  ISOTimestamp,
  ChallengeResponse,
} from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeActionId(id: string): ActionId {
  return id as ActionId;
}

function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

function makeCorrelationId(id: string): CorrelationId {
  return id as CorrelationId;
}

// ─── Mock Implementations ────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentSeconds = 1700000000; // ~Nov 2023

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): ISOTimestamp {
    return new Date(this.currentSeconds * 1000).toISOString() as ISOTimestamp;
  }

  advance(seconds: number): void {
    this.currentSeconds += seconds;
  }

  set(seconds: number): void {
    this.currentSeconds = seconds;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `challenge-uuid-${this.counter}`;
  }
}

class MockNonceGenerator implements INonceGenerator {
  private nextNonce = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  generate(): string {
    return this.nextNonce;
  }

  setNext(nonce: string): void {
    this.nextNonce = nonce;
  }
}

class MockChallengeAuditEmitter implements IChallengeAuditEmitter {
  readonly emittedEvents: Array<{
    payload: ChallengeAuditPayload;
    correlationId: CorrelationId;
  }> = [];
  private eventCounter = 0;

  async emit(
    payload: ChallengeAuditPayload,
    correlationId: CorrelationId,
  ): Promise<string> {
    this.eventCounter++;
    const eventId = `challenge-audit-${this.eventCounter}`;
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

describe('ConfirmationChallengeService', () => {
  let service: ConfirmationChallengeService;
  let challengeStore: InMemoryChallengeStore;
  let lockoutStore: InMemoryLockoutStore;
  let nonceGenerator: MockNonceGenerator;
  let auditEmitter: MockChallengeAuditEmitter;
  let clock: MockClock;
  let idGenerator: MockIdGenerator;
  let config: ConfirmationChallengeConfig;

  const sessionId = makeSessionId('session-1');
  const actionId = makeActionId('action-1');
  const correlationId = makeCorrelationId('corr-1');

  beforeEach(() => {
    clock = new MockClock();
    challengeStore = new InMemoryChallengeStore();
    lockoutStore = new InMemoryLockoutStore(clock);
    nonceGenerator = new MockNonceGenerator();
    auditEmitter = new MockChallengeAuditEmitter();
    idGenerator = new MockIdGenerator();
    config = {
      expirySeconds: 60,
      maxFailuresBeforeLockout: 5,
      lockoutDurationSeconds: 300,
    };

    service = new ConfirmationChallengeService({
      challengeStore,
      lockoutStore,
      nonceGenerator,
      auditEmitter,
      clock,
      idGenerator,
      config,
    });
  });

  // ─── Issuance Tests (Requirement 24.1) ──────────────────────────────────────

  describe('issueChallenge', () => {
    it('should issue a challenge with server nonce', async () => {
      const request: IssueChallengeRequest = {
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      };

      const challenge = await service.issueChallenge(request);

      expect(challenge.nonce).toBe(nonceGenerator.generate());
      expect(challenge.nonce).toHaveLength(64); // 32 bytes hex
    });

    it('should set expiry to exactly 60 seconds from now', async () => {
      const request: IssueChallengeRequest = {
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      };

      const challenge = await service.issueChallenge(request);

      const expectedExpiry = new Date(
        (clock.nowSeconds() + 60) * 1000,
      ).toISOString();
      expect(challenge.expires_at).toBe(expectedExpiry);
    });

    it('should cap expiry at 60 seconds even if config is higher', async () => {
      // Recreate service with higher expiry config
      const highExpiryService = new ConfirmationChallengeService({
        challengeStore,
        lockoutStore,
        nonceGenerator,
        auditEmitter,
        clock,
        idGenerator,
        config: { ...config, expirySeconds: 120 },
      });

      const challenge = await highExpiryService.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test action',
        correlation_id: correlationId,
      });

      const expectedExpiry = new Date(
        (clock.nowSeconds() + 60) * 1000,
      ).toISOString();
      expect(challenge.expires_at).toBe(expectedExpiry);
    });

    it('should bind challenge to action_request_id', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      expect(challenge.action_request_id).toBe(actionId);
    });

    it('should bind challenge to session_id', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      expect(challenge.session_id).toBe(sessionId);
    });

    it('should set consumed to false on issuance', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      expect(challenge.consumed).toBe(false);
    });

    it('should include action_description', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      expect(challenge.action_description).toBe('Delete all user data');
    });

    it('should emit CHALLENGE_ISSUED audit event', async () => {
      await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      expect(auditEmitter.emittedEvents).toHaveLength(1);
      const event = auditEmitter.lastEvent!;
      expect(event.payload.event_type).toBe('CHALLENGE_ISSUED');
      expect(event.payload.session_id).toBe(sessionId);
      expect(event.payload.action_request_id).toBe(actionId);
      expect(event.correlationId).toBe(correlationId);
    });

    it('should persist challenge in store', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      const stored = await challengeStore.get(challenge.challenge_id);
      expect(stored).not.toBeNull();
      expect(stored!.nonce).toBe(challenge.nonce);
    });
  });

  // ─── Validation Tests (Requirement 24.4) ────────────────────────────────────

  describe('validateChallenge — success', () => {
    it('should accept when all 4 conditions hold', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Delete all user data',
        correlation_id: correlationId,
      });

      // Advance time but stay within expiry
      clock.advance(30);

      const response: ChallengeResponse = {
        challenge_id: challenge.challenge_id,
        nonce: challenge.nonce,
        session_id: sessionId,
        input_method: 'hud_input',
      };

      const result = await service.validateChallenge({
        response,
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(true);
      expect(result.action_request_id).toBe(actionId);
      expect(result.rejection_reason).toBeUndefined();
    });

    it('should emit CHALLENGE_VALIDATED audit event on success', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      auditEmitter.clear();

      await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'voice',
        },
        correlation_id: correlationId,
      });

      const successEvent = auditEmitter.emittedEvents.find(
        (e) => e.payload.event_type === 'CHALLENGE_VALIDATED',
      );
      expect(successEvent).toBeDefined();
      expect(successEvent!.payload.challenge_id).toBe(
        challenge.challenge_id as string,
      );
    });

    it('should reset lockout counter on successful validation', async () => {
      // Record some failures first
      await lockoutStore.recordFailure(sessionId);
      await lockoutStore.recordFailure(sessionId);

      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      const count = await lockoutStore.getFailureCount(sessionId);
      expect(count).toBe(0);
    });
  });

  // ─── Validation Failure Tests (Requirement 24.4, 24.5) ─────────────────────

  describe('validateChallenge — nonce mismatch', () => {
    it('should reject when nonce does not match', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: 'wrong-nonce-value',
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(false);
      expect(result.rejection_reason).toBe('NONCE_MISMATCH');
    });
  });

  describe('validateChallenge — expired', () => {
    it('should reject when challenge has expired', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      // Advance past expiry
      clock.advance(61);

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(false);
      expect(result.rejection_reason).toBe('EXPIRED');
    });

    it('should accept at exactly 59 seconds (within window)', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      clock.advance(59);

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('validateChallenge — session mismatch', () => {
    it('should reject when session_id does not match', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      const differentSession = makeSessionId('session-different');

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: differentSession,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(false);
      expect(result.rejection_reason).toBe('SESSION_MISMATCH');
    });
  });

  describe('validateChallenge — already consumed (single-use)', () => {
    it('should reject when challenge has already been consumed', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      // First validation — should succeed
      const firstResult = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });
      expect(firstResult.valid).toBe(true);

      // Second validation — should fail (already consumed)
      const secondResult = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(secondResult.valid).toBe(false);
      expect(secondResult.rejection_reason).toBe('ALREADY_CONSUMED');
    });
  });

  describe('validateChallenge — challenge not found', () => {
    it('should reject when challenge_id does not exist', async () => {
      const result = await service.validateChallenge({
        response: {
          challenge_id: 'nonexistent-id' as ChallengeId,
          nonce: 'some-nonce',
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(false);
      expect(result.rejection_reason).toBe('CHALLENGE_NOT_FOUND');
    });
  });

  // ─── Action Binding Tests (Requirement 24.6) ────────────────────────────────

  describe('action binding', () => {
    it('should return the bound action_request_id on success', async () => {
      const specificActionId = makeActionId('specific-action-123');

      const challenge = await service.issueChallenge({
        action_request_id: specificActionId,
        session_id: sessionId,
        action_description: 'Specific action',
        correlation_id: correlationId,
      });

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(true);
      expect(result.action_request_id).toBe(specificActionId);
    });

    it('should bind different challenges to different actions', async () => {
      const action1 = makeActionId('action-1');
      const action2 = makeActionId('action-2');

      nonceGenerator.setNext('nonce-for-action-1-aaaa-bbbb-cccc-dddd-eeee-ffff-0000');
      const challenge1 = await service.issueChallenge({
        action_request_id: action1,
        session_id: sessionId,
        action_description: 'Action 1',
        correlation_id: correlationId,
      });

      nonceGenerator.setNext('nonce-for-action-2-aaaa-bbbb-cccc-dddd-eeee-ffff-1111');
      const challenge2 = await service.issueChallenge({
        action_request_id: action2,
        session_id: sessionId,
        action_description: 'Action 2',
        correlation_id: correlationId,
      });

      expect(challenge1.action_request_id).toBe(action1);
      expect(challenge2.action_request_id).toBe(action2);
    });
  });

  // ─── Progressive Lockout Tests (Requirement 24.5) ───────────────────────────

  describe('progressive lockout', () => {
    it('should lock out session after N consecutive failures', async () => {
      // Issue challenges and fail validation 5 times
      for (let i = 0; i < 5; i++) {
        nonceGenerator.setNext(`nonce-${i}-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd`);
        const challenge = await service.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await service.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      // Next attempt should be locked out
      nonceGenerator.setNext('final-nonce-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd-ee');
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(false);
      expect(result.rejection_reason).toBe('SESSION_LOCKED_OUT');
      expect(result.locked_out).toBe(true);
    });

    it('should emit CHALLENGE_LOCKOUT_TRIGGERED audit event', async () => {
      for (let i = 0; i < 5; i++) {
        nonceGenerator.setNext(`nonce-${i}-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd`);
        const challenge = await service.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await service.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      const lockoutEvent = auditEmitter.emittedEvents.find(
        (e) => e.payload.event_type === 'CHALLENGE_LOCKOUT_TRIGGERED',
      );
      expect(lockoutEvent).toBeDefined();
      expect(lockoutEvent!.payload.failure_count).toBe(5);
      expect(lockoutEvent!.payload.lockout_until).toBeDefined();
    });

    it('should unlock session after lockout duration expires', async () => {
      // Trigger lockout
      for (let i = 0; i < 5; i++) {
        nonceGenerator.setNext(`nonce-${i}-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd`);
        const challenge = await service.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await service.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      // Advance past lockout duration (5 minutes = 300 seconds)
      clock.advance(301);

      // Should now be able to validate again
      nonceGenerator.setNext('new-valid-nonce-padding-64-chars-aaaa-bbbb-cccc-dddd-eeee-ff');
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(true);
    });

    it('should not lock out before reaching threshold', async () => {
      // Fail 4 times (threshold is 5)
      for (let i = 0; i < 4; i++) {
        nonceGenerator.setNext(`nonce-${i}-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd`);
        const challenge = await service.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await service.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      // 5th attempt with correct nonce should still work
      nonceGenerator.setNext('correct-nonce-padding-64-chars-aaaa-bbbb-cccc-dddd-eeee-ffff');
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(true);
    });

    it('should reset failure counter on successful validation', async () => {
      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        nonceGenerator.setNext(`nonce-${i}-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd`);
        const challenge = await service.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await service.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      // Succeed once — should reset counter
      nonceGenerator.setNext('correct-nonce-padding-64-chars-aaaa-bbbb-cccc-dddd-eeee-ffff');
      const goodChallenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      await service.validateChallenge({
        response: {
          challenge_id: goodChallenge.challenge_id,
          nonce: goodChallenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      // Now fail 4 more times — should NOT trigger lockout (counter was reset)
      for (let i = 0; i < 4; i++) {
        nonceGenerator.setNext(`nonce-post-${i}-padding-64-chars-aaaa-bbbb-cccc-dddd-ee`);
        const challenge = await service.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await service.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      // Should still not be locked out
      const isLocked = await lockoutStore.isLockedOut(sessionId);
      expect(isLocked).toBe(false);
    });

    it('should use configurable lockout threshold', async () => {
      // Create service with lower threshold (3)
      const strictService = new ConfirmationChallengeService({
        challengeStore,
        lockoutStore,
        nonceGenerator,
        auditEmitter,
        clock,
        idGenerator,
        config: { ...config, maxFailuresBeforeLockout: 3 },
      });

      for (let i = 0; i < 3; i++) {
        nonceGenerator.setNext(`nonce-${i}-padding-to-make-64-chars-aaaa-bbbb-cccc-dddd`);
        const challenge = await strictService.issueChallenge({
          action_request_id: actionId,
          session_id: sessionId,
          action_description: 'Test',
          correlation_id: correlationId,
        });

        await strictService.validateChallenge({
          response: {
            challenge_id: challenge.challenge_id,
            nonce: 'wrong-nonce',
            session_id: sessionId,
            input_method: 'hud_input',
          },
          correlation_id: correlationId,
        });
      }

      const isLocked = await lockoutStore.isLockedOut(sessionId);
      expect(isLocked).toBe(true);
    });
  });

  // ─── Audit Event Tests ──────────────────────────────────────────────────────

  describe('audit events', () => {
    it('should emit CHALLENGE_FAILED on every failed validation', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      auditEmitter.clear();

      await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: 'wrong-nonce',
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      const failEvent = auditEmitter.emittedEvents.find(
        (e) => e.payload.event_type === 'CHALLENGE_FAILED',
      );
      expect(failEvent).toBeDefined();
      expect(failEvent!.payload.rejection_reason).toBe('NONCE_MISMATCH');
      expect(failEvent!.payload.failure_count).toBe(1);
    });

    it('should invalidate nonce on failed validation', async () => {
      const challenge = await service.issueChallenge({
        action_request_id: actionId,
        session_id: sessionId,
        action_description: 'Test',
        correlation_id: correlationId,
      });

      // Fail with wrong nonce
      await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: 'wrong-nonce',
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      // Try again with correct nonce — should fail (invalidated)
      const result = await service.validateChallenge({
        response: {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          session_id: sessionId,
          input_method: 'hud_input',
        },
        correlation_id: correlationId,
      });

      expect(result.valid).toBe(false);
      expect(result.rejection_reason).toBe('ALREADY_CONSUMED');
    });
  });
});
