/**
 * Unit tests for ActionAuditEmitter.
 *
 * Verifies:
 * - Audit events are emitted for all action lifecycle phases
 * - Correct severity mapping for outcomes
 * - Payload includes all required fields
 * - Graceful handling of audit service failures
 *
 * @see Requirement 2.6 - Emit audit event within 1s of completion
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ActionRequest, AuditSeverity } from '@may/types';
import type { ActionId, IdempotencyKey, TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { ActionAuditEmitter } from '../src/action-audit-emitter.js';
import type { IAuditServiceClient } from '../src/action-audit-emitter.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

interface IngestedEvent {
  timestamp: string;
  tenant_id: string;
  principal_id: string;
  source_service: string;
  event_category: string;
  severity: AuditSeverity;
  correlation_id: string;
  outcome: string;
  payload?: Record<string, unknown>;
}

class StubAuditClient implements IAuditServiceClient {
  readonly events: IngestedEvent[] = [];
  private eventCounter = 0;
  shouldFail = false;

  async ingest(event: IngestedEvent): Promise<{ event_id: string }> {
    if (this.shouldFail) {
      throw new Error('Audit service unavailable');
    }
    this.events.push(event);
    this.eventCounter++;
    return { event_id: `audit-event-${this.eventCounter}` };
  }
}

function createTestRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action_id: 'action-123' as ActionId,
    idempotency_key: 'idem-key-456' as IdempotencyKey,
    risk_level: 'MEDIUM',
    action_type: 'file.delete',
    parameters: { path: '/tmp/test.txt' },
    timeout_seconds: 60,
    context: {
      tenant_id: 'tenant-1' as TenantId,
      principal_id: 'user-1' as PrincipalId,
      correlation_id: 'corr-789' as CorrelationId,
      trace_context: { traceparent: '00-trace-span-01' },
      session_id: 'session-1' as SessionId,
      roles: ['End_User'],
      attributes: {},
      residency_region: 'us-east-1',
    },
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('ActionAuditEmitter', () => {
  let auditClient: StubAuditClient;
  let emitter: ActionAuditEmitter;
  let currentTime: number;

  beforeEach(() => {
    currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
    auditClient = new StubAuditClient();
    emitter = new ActionAuditEmitter(auditClient, () => currentTime);
  });

  // ─── Event Emission ────────────────────────────────────────────────────

  describe('event emission', () => {
    it('should emit action.started event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.started', 'SUCCESS', 0);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.started');
    });

    it('should emit action.completed event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 150);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.completed');
      expect(auditClient.events[0]!.outcome).toBe('SUCCESS');
    });

    it('should emit action.failed event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.failed', 'FAILURE', 200);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.failed');
      expect(auditClient.events[0]!.outcome).toBe('FAILURE');
    });

    it('should emit action.timeout event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.timeout', 'TIMEOUT', 60000);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.timeout');
      expect(auditClient.events[0]!.outcome).toBe('TIMEOUT');
    });

    it('should emit action.cancelled event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.cancelled', 'CANCELLED', 5000);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.cancelled');
    });

    it('should emit action.denied event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.denied', 'DENIED', 10);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.denied');
    });

    it('should emit action.idempotent_hit event', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.idempotent_hit', 'SUCCESS', 5);

      expect(auditClient.events).toHaveLength(1);
      expect(auditClient.events[0]!.event_category).toBe('action.idempotent_hit');
    });
  });

  // ─── Payload Content ───────────────────────────────────────────────────

  describe('payload content', () => {
    it('should include action_id in payload', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.action_id).toBe('action-123');
    });

    it('should include action_type in payload', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.action_type).toBe('file.delete');
    });

    it('should include risk_level in payload', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.risk_level).toBe('MEDIUM');
    });

    it('should include idempotency_key in payload', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.idempotency_key).toBe('idem-key-456');
    });

    it('should include outcome in payload', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.outcome).toBe('SUCCESS');
    });

    it('should include duration_ms in payload', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 150);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.duration_ms).toBe(150);
    });

    it('should include additional details when provided', async () => {
      const request = createTestRequest();
      const details = { timeout_seconds: 60, reason: 'exceeded' };
      await emitter.emit(request, 'action.timeout', 'TIMEOUT', 60000, details);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.details).toEqual(details);
    });

    it('should not include details field when not provided', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      const payload = auditClient.events[0]!.payload!;
      expect(payload.details).toBeUndefined();
    });
  });

  // ─── Context Propagation ───────────────────────────────────────────────

  describe('context propagation', () => {
    it('should use tenant_id from request context', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(auditClient.events[0]!.tenant_id).toBe('tenant-1');
    });

    it('should use principal_id from request context', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(auditClient.events[0]!.principal_id).toBe('user-1');
    });

    it('should use correlation_id from request context', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(auditClient.events[0]!.correlation_id).toBe('corr-789');
    });

    it('should set source_service to Control_Service', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(auditClient.events[0]!.source_service).toBe('Control_Service');
    });
  });

  // ─── Severity Mapping ──────────────────────────────────────────────────

  describe('severity mapping', () => {
    it('should use INFO severity for started events', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.started', 'SUCCESS', 0);

      expect(auditClient.events[0]!.severity).toBe('INFO');
    });

    it('should use INFO severity for SUCCESS outcome', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(auditClient.events[0]!.severity).toBe('INFO');
    });

    it('should use MEDIUM severity for FAILURE outcome', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.failed', 'FAILURE', 100);

      expect(auditClient.events[0]!.severity).toBe('MEDIUM');
    });

    it('should use MEDIUM severity for TIMEOUT outcome', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.timeout', 'TIMEOUT', 60000);

      expect(auditClient.events[0]!.severity).toBe('MEDIUM');
    });

    it('should use LOW severity for CANCELLED outcome', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.cancelled', 'CANCELLED', 5000);

      expect(auditClient.events[0]!.severity).toBe('LOW');
    });

    it('should use HIGH severity for DENIED outcome', async () => {
      const request = createTestRequest();
      await emitter.emit(request, 'action.denied', 'DENIED', 10);

      expect(auditClient.events[0]!.severity).toBe('HIGH');
    });
  });

  // ─── Result ────────────────────────────────────────────────────────────

  describe('emit result', () => {
    it('should return success with event_id on successful emission', async () => {
      const request = createTestRequest();
      const result = await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(result.success).toBe(true);
      expect(result.event_id).toBe('audit-event-1');
      expect(result.emit_duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should return failure when audit service is unavailable', async () => {
      auditClient.shouldFail = true;
      const request = createTestRequest();
      const result = await emitter.emit(request, 'action.completed', 'SUCCESS', 100);

      expect(result.success).toBe(false);
      expect(result.event_id).toBe('');
    });

    it('should not throw when audit service fails', async () => {
      auditClient.shouldFail = true;
      const request = createTestRequest();

      // Should not throw
      await expect(
        emitter.emit(request, 'action.completed', 'SUCCESS', 100),
      ).resolves.toBeDefined();
    });
  });
});
