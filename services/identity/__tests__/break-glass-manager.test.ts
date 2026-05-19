/**
 * Unit tests for BreakGlassManager — emergency access with dual approval.
 *
 * @see Requirement 12.6 - Break-glass with dual approval, 4h limit, audit events
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BreakGlassManager, MAX_BREAK_GLASS_DURATION_SECONDS } from '../src/break-glass-manager.js';
import type { IBreakGlassGrantStore } from '../src/break-glass-manager.js';
import type {
  BreakGlassRequest,
  BreakGlassGrant,
  IAuditEmitter,
} from '../src/interfaces/service-auth.js';
import type { IClock, IIdGenerator } from '../src/interfaces/index.js';
import type { PrincipalId, ISOTimestamp } from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePrincipalId(id: string): PrincipalId {
  return id as PrincipalId;
}

class MockClock implements IClock {
  private currentSeconds = 1700000000; // 2023-11-14T22:13:20Z

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
    return `grant-${this.counter}`;
  }
}

class MockAuditEmitter implements IAuditEmitter {
  readonly events: Array<{
    event_category: string;
    severity: string;
    principal_id: string;
    source_service: string;
    outcome: string;
    payload: Record<string, unknown>;
  }> = [];

  async emit(event: {
    event_category: string;
    severity: string;
    principal_id: string;
    source_service: string;
    outcome: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.events.push({ ...event, payload: { ...event.payload } });
  }
}

class InMemoryGrantStore implements IBreakGlassGrantStore {
  private readonly grants: Map<string, BreakGlassGrant> = new Map();

  async store(grant: BreakGlassGrant): Promise<void> {
    this.grants.set(grant.grant_id, grant);
  }

  async get(grantId: string): Promise<BreakGlassGrant | null> {
    return this.grants.get(grantId) ?? null;
  }

  async update(grant: BreakGlassGrant): Promise<void> {
    this.grants.set(grant.grant_id, grant);
  }
}

function makeValidRequest(overrides?: Partial<BreakGlassRequest>): BreakGlassRequest {
  return {
    requester_id: makePrincipalId('requester-1'),
    approver_ids: [makePrincipalId('approver-1'), makePrincipalId('approver-2')],
    reason: 'Production incident requires emergency access',
    target_service: 'secrets-service',
    target_action: 'rotate-key',
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('BreakGlassManager', () => {
  let manager: BreakGlassManager;
  let clock: MockClock;
  let idGenerator: MockIdGenerator;
  let auditEmitter: MockAuditEmitter;
  let grantStore: InMemoryGrantStore;

  beforeEach(() => {
    clock = new MockClock();
    idGenerator = new MockIdGenerator();
    auditEmitter = new MockAuditEmitter();
    grantStore = new InMemoryGrantStore();

    manager = new BreakGlassManager({
      clock,
      idGenerator,
      auditEmitter,
      grantStore,
    });
  });

  describe('requestBreakGlass', () => {
    it('should grant break-glass access with valid dual approval', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      expect(grant).not.toBeNull();
      expect(grant!.grant_id).toBe('grant-1');
      expect(grant!.requester_id).toBe('requester-1');
      expect(grant!.approvers).toEqual(['approver-1', 'approver-2']);
      expect(grant!.target_service).toBe('secrets-service');
      expect(grant!.target_action).toBe('rotate-key');
      expect(grant!.revoked).toBe(false);
    });

    it('should set expiry to exactly 4 hours from grant time', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      const grantedAtMs = new Date(grant!.granted_at).getTime();
      const expiresAtMs = new Date(grant!.expires_at).getTime();
      const durationSeconds = (expiresAtMs - grantedAtMs) / 1000;

      expect(durationSeconds).toBe(MAX_BREAK_GLASS_DURATION_SECONDS);
      expect(durationSeconds).toBe(4 * 60 * 60); // 14400 seconds
    });

    it('should emit HIGH severity audit event on activation', async () => {
      const request = makeValidRequest();
      await manager.requestBreakGlass(request);

      const activationEvent = auditEmitter.events.find(
        (e) => e.event_category === 'break_glass.activated',
      );
      expect(activationEvent).toBeDefined();
      expect(activationEvent!.severity).toBe('HIGH');
      expect(activationEvent!.outcome).toBe('SUCCESS');
      expect(activationEvent!.payload['grant_id']).toBe('grant-1');
      expect(activationEvent!.payload['approvers']).toEqual(['approver-1', 'approver-2']);
      expect(activationEvent!.payload['reason']).toBe('Production incident requires emergency access');
    });

    it('should reject when fewer than 2 approvers provided', async () => {
      const request = makeValidRequest({
        approver_ids: [makePrincipalId('approver-1')] as unknown as [PrincipalId, PrincipalId],
      });
      const grant = await manager.requestBreakGlass(request);

      expect(grant).toBeNull();
      expect(auditEmitter.events[0]!.event_category).toBe('break_glass.request_denied');
      expect(auditEmitter.events[0]!.payload['reason']).toBe('INSUFFICIENT_APPROVERS');
    });

    it('should reject when requester is one of the approvers', async () => {
      const request = makeValidRequest({
        requester_id: makePrincipalId('approver-1'),
        approver_ids: [makePrincipalId('approver-1'), makePrincipalId('approver-2')],
      });
      const grant = await manager.requestBreakGlass(request);

      expect(grant).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('REQUESTER_IS_APPROVER');
    });

    it('should reject when both approvers are the same person', async () => {
      const request = makeValidRequest({
        approver_ids: [makePrincipalId('approver-1'), makePrincipalId('approver-1')],
      });
      const grant = await manager.requestBreakGlass(request);

      expect(grant).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('DUPLICATE_APPROVERS');
    });

    it('should reject when reason is empty', async () => {
      const request = makeValidRequest({ reason: '   ' });
      const grant = await manager.requestBreakGlass(request);

      expect(grant).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('EMPTY_REASON');
    });

    it('should reject when target service is empty', async () => {
      const request = makeValidRequest({ target_service: '' });
      const grant = await manager.requestBreakGlass(request);

      expect(grant).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('EMPTY_TARGET');
    });

    it('should reject when target action is empty', async () => {
      const request = makeValidRequest({ target_action: '  ' });
      const grant = await manager.requestBreakGlass(request);

      expect(grant).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('EMPTY_TARGET');
    });

    it('should persist grant to store', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      const stored = await grantStore.get(grant!.grant_id);
      expect(stored).toEqual(grant);
    });
  });

  describe('validateBreakGlass', () => {
    it('should return true for active, non-expired, non-revoked grant', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      const valid = await manager.validateBreakGlass(grant!.grant_id);
      expect(valid).toBe(true);
    });

    it('should return false for non-existent grant', async () => {
      const valid = await manager.validateBreakGlass('non-existent-grant');
      expect(valid).toBe(false);
    });

    it('should return false for revoked grant', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      await manager.revokeBreakGlass(grant!.grant_id);

      const valid = await manager.validateBreakGlass(grant!.grant_id);
      expect(valid).toBe(false);
    });

    it('should return false for expired grant (after 4 hours)', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      // Advance time past 4h expiry
      clock.advance(MAX_BREAK_GLASS_DURATION_SECONDS + 1);

      const valid = await manager.validateBreakGlass(grant!.grant_id);
      expect(valid).toBe(false);
    });

    it('should emit expiration audit event when grant is expired', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);
      auditEmitter.events.length = 0; // Clear activation event

      // Advance time past 4h expiry
      clock.advance(MAX_BREAK_GLASS_DURATION_SECONDS + 1);

      await manager.validateBreakGlass(grant!.grant_id);

      const expirationEvent = auditEmitter.events.find(
        (e) => e.event_category === 'break_glass.expired',
      );
      expect(expirationEvent).toBeDefined();
      expect(expirationEvent!.severity).toBe('HIGH');
      expect(expirationEvent!.outcome).toBe('EXPIRED');
    });

    it('should return true just before expiry', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      // Advance time to just before expiry (4h - 1s)
      clock.advance(MAX_BREAK_GLASS_DURATION_SECONDS - 1);

      const valid = await manager.validateBreakGlass(grant!.grant_id);
      expect(valid).toBe(true);
    });
  });

  describe('revokeBreakGlass', () => {
    it('should revoke an active grant', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      await manager.revokeBreakGlass(grant!.grant_id);

      const stored = await grantStore.get(grant!.grant_id);
      expect(stored!.revoked).toBe(true);
    });

    it('should emit HIGH severity audit event on revocation', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);
      auditEmitter.events.length = 0; // Clear activation event

      await manager.revokeBreakGlass(grant!.grant_id);

      const revocationEvent = auditEmitter.events.find(
        (e) => e.event_category === 'break_glass.revoked',
      );
      expect(revocationEvent).toBeDefined();
      expect(revocationEvent!.severity).toBe('HIGH');
      expect(revocationEvent!.outcome).toBe('REVOKED');
      expect(revocationEvent!.payload['grant_id']).toBe(grant!.grant_id);
    });

    it('should be idempotent (revoking already-revoked grant does nothing)', async () => {
      const request = makeValidRequest();
      const grant = await manager.requestBreakGlass(request);

      await manager.revokeBreakGlass(grant!.grant_id);
      auditEmitter.events.length = 0;

      // Second revocation should be idempotent
      await manager.revokeBreakGlass(grant!.grant_id);
      expect(auditEmitter.events).toHaveLength(0);
    });

    it('should throw for non-existent grant', async () => {
      await expect(manager.revokeBreakGlass('non-existent')).rejects.toThrow(
        'Break-glass grant not found: non-existent',
      );
    });
  });

  describe('full lifecycle', () => {
    it('should support request → validate → revoke → validate flow', async () => {
      // Request
      const grant = await manager.requestBreakGlass(makeValidRequest());
      expect(grant).not.toBeNull();

      // Validate (should be active)
      expect(await manager.validateBreakGlass(grant!.grant_id)).toBe(true);

      // Revoke
      await manager.revokeBreakGlass(grant!.grant_id);

      // Validate again (should be invalid)
      expect(await manager.validateBreakGlass(grant!.grant_id)).toBe(false);
    });

    it('should support request → time passes → validate (expired) flow', async () => {
      // Request
      const grant = await manager.requestBreakGlass(makeValidRequest());
      expect(grant).not.toBeNull();

      // Validate immediately (should be active)
      expect(await manager.validateBreakGlass(grant!.grant_id)).toBe(true);

      // Time passes (4h + 1s)
      clock.advance(MAX_BREAK_GLASS_DURATION_SECONDS + 1);

      // Validate again (should be expired)
      expect(await manager.validateBreakGlass(grant!.grant_id)).toBe(false);
    });

    it('should emit audit events at both activation and expiration', async () => {
      const grant = await manager.requestBreakGlass(makeValidRequest());

      // Activation event
      const activationEvents = auditEmitter.events.filter(
        (e) => e.event_category === 'break_glass.activated',
      );
      expect(activationEvents).toHaveLength(1);

      // Advance past expiry and validate to trigger expiration event
      clock.advance(MAX_BREAK_GLASS_DURATION_SECONDS + 1);
      await manager.validateBreakGlass(grant!.grant_id);

      const expirationEvents = auditEmitter.events.filter(
        (e) => e.event_category === 'break_glass.expired',
      );
      expect(expirationEvents).toHaveLength(1);
    });
  });
});
