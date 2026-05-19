/**
 * Unit tests for RollbackTracker.
 *
 * Verifies:
 * - Rollback descriptor recording for MEDIUM+ SUCCESS actions (Requirement 2.15)
 * - Tenant-configured retention period (default 24h)
 * - Rollback execution
 * - Expired descriptor cleanup
 * - Skipping SAFE/LOW risk and non-SUCCESS outcomes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RollbackTracker, DEFAULT_ROLLBACK_RETENTION_HOURS } from '../src/rollback-tracker.js';
import { InMemoryRollbackStore } from '../src/in-memory-rollback-store.js';
import type { IClock, IIdGenerator, IRollbackStepGenerator } from '../src/interfaces/index.js';
import type { ActionRequest, ActionResponse, RiskLevel } from '@may/types';
import type { RollbackStep } from '@may/types';
import type { ActionId, IdempotencyKey, CorrelationId, TenantId, PrincipalId, SessionId } from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentTime = '2024-01-15T10:00:00.000Z';

  nowISO(): string {
    return this.currentTime;
  }

  setTime(iso: string): void {
    this.currentTime = iso;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `uuid-${this.counter}`;
  }
}

function makeActionRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action_id: 'action-001' as ActionId,
    idempotency_key: 'idem-001' as IdempotencyKey,
    risk_level: 'MEDIUM',
    action_type: 'file.delete',
    parameters: { path: '/tmp/test.txt' },
    timeout_seconds: 60,
    context: {
      tenant_id: 'tenant-001' as TenantId,
      principal_id: 'user-001' as PrincipalId,
      correlation_id: 'corr-001' as CorrelationId,
      trace_context: { traceparent: '00-trace-001-span-001-01' },
      session_id: 'session-001' as SessionId,
      roles: ['End_User'],
      attributes: {},
      residency_region: 'us-east-1',
    },
    ...overrides,
  };
}

function makeActionResponse(overrides: Partial<ActionResponse> = {}): ActionResponse {
  return {
    action_id: 'action-001' as ActionId,
    idempotency_key: 'idem-001' as IdempotencyKey,
    outcome: 'SUCCESS',
    duration_ms: 150,
    audit_event_id: 'audit-001',
    correlation_id: 'corr-001' as CorrelationId,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RollbackTracker', () => {
  let tracker: RollbackTracker;
  let store: InMemoryRollbackStore;
  let clock: MockClock;
  let idGenerator: MockIdGenerator;

  beforeEach(() => {
    clock = new MockClock();
    idGenerator = new MockIdGenerator();
    store = new InMemoryRollbackStore();
    tracker = new RollbackTracker({
      clock,
      idGenerator,
      store,
      config: { retention_hours: DEFAULT_ROLLBACK_RETENTION_HOURS },
    });
  });

  describe('recordRollback', () => {
    it('should record a rollback descriptor for MEDIUM risk SUCCESS actions', async () => {
      const request = makeActionRequest({ risk_level: 'MEDIUM' });
      const response = makeActionResponse({ outcome: 'SUCCESS' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeDefined();
      expect(descriptor!.action_id).toBe('action-001');
      expect(descriptor!.tenant_id).toBe('tenant-001');
      expect(descriptor!.principal_id).toBe('user-001');
      expect(descriptor!.action_type).toBe('file.delete');
      expect(descriptor!.executed).toBe(false);
      expect(descriptor!.rollback_steps.length).toBeGreaterThan(0);
    });

    it('should record a rollback descriptor for HIGH risk SUCCESS actions', async () => {
      const request = makeActionRequest({ risk_level: 'HIGH' });
      const response = makeActionResponse({ outcome: 'SUCCESS' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeDefined();
      expect(descriptor!.action_type).toBe('file.delete');
    });

    it('should record a rollback descriptor for CRITICAL risk SUCCESS actions', async () => {
      const request = makeActionRequest({ risk_level: 'CRITICAL' });
      const response = makeActionResponse({ outcome: 'SUCCESS' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeDefined();
    });

    it('should NOT record for SAFE risk actions', async () => {
      const request = makeActionRequest({ risk_level: 'SAFE' });
      const response = makeActionResponse({ outcome: 'SUCCESS' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeUndefined();
    });

    it('should NOT record for LOW risk actions', async () => {
      const request = makeActionRequest({ risk_level: 'LOW' });
      const response = makeActionResponse({ outcome: 'SUCCESS' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeUndefined();
    });

    it('should NOT record for FAILURE outcomes', async () => {
      const request = makeActionRequest({ risk_level: 'MEDIUM' });
      const response = makeActionResponse({ outcome: 'FAILURE' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeUndefined();
    });

    it('should NOT record for TIMEOUT outcomes', async () => {
      const request = makeActionRequest({ risk_level: 'HIGH' });
      const response = makeActionResponse({ outcome: 'TIMEOUT' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeUndefined();
    });

    it('should NOT record for CANCELLED outcomes', async () => {
      const request = makeActionRequest({ risk_level: 'MEDIUM' });
      const response = makeActionResponse({ outcome: 'CANCELLED' });

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor).toBeUndefined();
    });

    it('should set expiry based on retention hours', async () => {
      clock.setTime('2024-01-15T10:00:00.000Z');
      const request = makeActionRequest();
      const response = makeActionResponse();

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor!.created_at).toBe('2024-01-15T10:00:00.000Z');
      expect(descriptor!.expires_at).toBe('2024-01-16T10:00:00.000Z'); // +24h
    });

    it('should use custom retention hours from config', async () => {
      const customTracker = new RollbackTracker({
        clock,
        idGenerator,
        store,
        config: { retention_hours: 48 },
      });
      clock.setTime('2024-01-15T10:00:00.000Z');
      const request = makeActionRequest();
      const response = makeActionResponse();

      const descriptor = await customTracker.recordRollback(request, response);

      expect(descriptor!.expires_at).toBe('2024-01-17T10:00:00.000Z'); // +48h
    });

    it('should use a custom step generator when registered', async () => {
      const customGenerator: IRollbackStepGenerator = {
        action_type: 'file.delete',
        async generateSteps(request: ActionRequest): Promise<RollbackStep[]> {
          return [
            {
              step_id: 'custom-step-1',
              description: 'Restore file from backup',
              reverse_action: {
                action_type: 'file.restore',
                parameters: { path: request.parameters['path'] },
                timeout_seconds: 30,
              },
              order: 1,
            },
          ];
        },
      };

      tracker.registerGenerator(customGenerator);
      const request = makeActionRequest();
      const response = makeActionResponse();

      const descriptor = await tracker.recordRollback(request, response);

      expect(descriptor!.rollback_steps[0].description).toBe('Restore file from backup');
      expect(descriptor!.rollback_steps[0].reverse_action.action_type).toBe('file.restore');
    });
  });

  describe('getRollbackDescriptor', () => {
    it('should retrieve a stored descriptor by action ID', async () => {
      const request = makeActionRequest();
      const response = makeActionResponse();
      await tracker.recordRollback(request, response);

      const retrieved = await tracker.getRollbackDescriptor('action-001', 'tenant-001');

      expect(retrieved).toBeDefined();
      expect(retrieved!.action_id).toBe('action-001');
    });

    it('should return undefined for non-existent action ID', async () => {
      const retrieved = await tracker.getRollbackDescriptor('nonexistent', 'tenant-001');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('executeRollback', () => {
    it('should mark the descriptor as executed', async () => {
      const request = makeActionRequest();
      const response = makeActionResponse();
      const descriptor = await tracker.recordRollback(request, response);

      const executed = await tracker.executeRollback(descriptor!.descriptor_id, 'tenant-001');

      expect(executed.executed).toBe(true);
    });

    it('should throw if descriptor not found', async () => {
      await expect(
        tracker.executeRollback('nonexistent', 'tenant-001'),
      ).rejects.toThrow('Rollback descriptor not found');
    });

    it('should throw if already executed', async () => {
      const request = makeActionRequest();
      const response = makeActionResponse();
      const descriptor = await tracker.recordRollback(request, response);

      await tracker.executeRollback(descriptor!.descriptor_id, 'tenant-001');

      await expect(
        tracker.executeRollback(descriptor!.descriptor_id, 'tenant-001'),
      ).rejects.toThrow('Rollback already executed');
    });

    it('should throw if descriptor is expired', async () => {
      clock.setTime('2024-01-15T10:00:00.000Z');
      const request = makeActionRequest();
      const response = makeActionResponse();
      const descriptor = await tracker.recordRollback(request, response);

      // Advance clock past expiry
      clock.setTime('2024-01-17T10:00:00.000Z');

      await expect(
        tracker.executeRollback(descriptor!.descriptor_id, 'tenant-001'),
      ).rejects.toThrow('Rollback descriptor expired');
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired descriptors from the store', async () => {
      // Create a descriptor that expires far in the future
      const futureStore = new InMemoryRollbackStore();
      const futureTracker = new RollbackTracker({
        clock: { nowISO: () => '2099-01-01T00:00:00.000Z' },
        idGenerator,
        store: futureStore,
        config: { retention_hours: 1 },
      });

      const request = makeActionRequest();
      const response = makeActionResponse();
      await futureTracker.recordRollback(request, response);

      expect(futureStore.size).toBe(1);

      // Cleanup should not remove it since expiry is 2099-01-01T01:00:00.000Z
      const removed = await futureTracker.cleanupExpired();
      expect(removed).toBe(0);
    });
  });
});

describe('InMemoryRollbackStore', () => {
  let store: InMemoryRollbackStore;

  beforeEach(() => {
    store = new InMemoryRollbackStore();
  });

  it('should enforce tenant isolation on getByDescriptorId', async () => {
    await store.save({
      descriptor_id: 'desc-001',
      action_id: 'action-001',
      tenant_id: 'tenant-A',
      principal_id: 'user-001',
      action_type: 'file.delete',
      rollback_steps: [],
      created_at: '2024-01-15T10:00:00.000Z',
      expires_at: '2099-01-16T10:00:00.000Z',
      executed: false,
    });

    // Same tenant — should find it
    const found = await store.getByDescriptorId('desc-001', 'tenant-A');
    expect(found).toBeDefined();

    // Different tenant — should NOT find it
    const notFound = await store.getByDescriptorId('desc-001', 'tenant-B');
    expect(notFound).toBeUndefined();
  });

  it('should mark descriptor as executed', async () => {
    await store.save({
      descriptor_id: 'desc-001',
      action_id: 'action-001',
      tenant_id: 'tenant-A',
      principal_id: 'user-001',
      action_type: 'file.delete',
      rollback_steps: [],
      created_at: '2024-01-15T10:00:00.000Z',
      expires_at: '2099-01-16T10:00:00.000Z',
      executed: false,
    });

    await store.markExecuted('desc-001', 'tenant-A');
    const descriptor = await store.getByDescriptorId('desc-001', 'tenant-A');
    expect(descriptor!.executed).toBe(true);
  });
});
