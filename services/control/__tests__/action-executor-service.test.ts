/**
 * Unit tests for ActionExecutorService.
 *
 * Verifies the integration of idempotency, timeout, and audit emission:
 * - Idempotent requests return cached results
 * - Timeout enforcement terminates long-running actions
 * - Audit events are emitted at each lifecycle phase
 * - Error handling and edge cases
 *
 * @see Requirement 2.6 - Emit audit event within 1s of completion
 * @see Requirement 2.7 - Idempotency keys with 24h deduplication window
 * @see Requirement 2.8 - Per-action timeout (1-600s, default 60s)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ActionRequest, ActionResponse } from '@may/types';
import type { ActionId, IdempotencyKey, CorrelationId, TenantId, PrincipalId, SessionId } from '@may/types';
import { ActionExecutorService } from '../src/action-executor-service.js';
import { InMemoryIdempotencyStore } from '../src/in-memory-idempotency-store.js';
import { TimeoutEnforcer } from '../src/timeout-enforcer.js';
import { ActionAuditEmitter } from '../src/action-audit-emitter.js';
import type { IAuditServiceClient } from '../src/action-audit-emitter.js';
import type { ActionAuditCategory, ActionExecutorFn } from '../src/interfaces/index.js';
import type { AuditSeverity } from '@may/types';

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

  async ingest(event: IngestedEvent): Promise<{ event_id: string }> {
    this.events.push(event);
    this.eventCounter++;
    return { event_id: `audit-${this.eventCounter}` };
  }
}

function createTestRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action_id: 'action-1' as ActionId,
    idempotency_key: 'idem-1' as IdempotencyKey,
    risk_level: 'LOW',
    action_type: 'file.read',
    parameters: { path: '/tmp/test.txt' },
    timeout_seconds: 60,
    context: {
      tenant_id: 'tenant-1' as TenantId,
      principal_id: 'user-1' as PrincipalId,
      correlation_id: 'corr-1' as CorrelationId,
      trace_context: { traceparent: '00-trace-span-01' },
      session_id: 'session-1' as SessionId,
      roles: ['End_User'],
      attributes: {},
      residency_region: 'us-east-1',
    },
    ...overrides,
  };
}

function createSuccessResponse(request: ActionRequest): ActionResponse {
  return {
    action_id: request.action_id,
    idempotency_key: request.idempotency_key,
    outcome: 'SUCCESS',
    result_data: { content: 'file contents' },
    duration_ms: 50,
    audit_event_id: 'audit-1',
    correlation_id: request.context.correlation_id as CorrelationId,
  };
}

function createSuccessExecutor(request: ActionRequest): ActionExecutorFn {
  return async (req, _signal) => createSuccessResponse(req);
}

function createDelayedExecutor(delayMs: number): ActionExecutorFn {
  return async (req, signal) => {
    return new Promise<ActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          action_id: req.action_id,
          idempotency_key: req.idempotency_key,
          outcome: 'SUCCESS',
          duration_ms: delayMs,
          audit_event_id: 'audit-delayed',
          correlation_id: req.context.correlation_id as CorrelationId,
        });
      }, delayMs);

      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      });
    });
  };
}

function createFailingExecutor(errorMsg: string): ActionExecutorFn {
  return async (req, _signal) => ({
    action_id: req.action_id,
    idempotency_key: req.idempotency_key,
    outcome: 'FAILURE',
    error: { code: 'EXECUTION_ERROR', message: errorMsg },
    duration_ms: 10,
    audit_event_id: 'audit-fail',
    correlation_id: req.context.correlation_id as CorrelationId,
  });
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('ActionExecutorService', () => {
  let currentTime: number;
  let idempotencyStore: InMemoryIdempotencyStore;
  let timeoutEnforcer: TimeoutEnforcer;
  let auditClient: StubAuditClient;
  let auditEmitter: ActionAuditEmitter;
  let service: ActionExecutorService;

  beforeEach(() => {
    currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
    idempotencyStore = new InMemoryIdempotencyStore(() => currentTime);
    timeoutEnforcer = new TimeoutEnforcer();
    auditClient = new StubAuditClient();
    auditEmitter = new ActionAuditEmitter(auditClient, () => currentTime);
    service = new ActionExecutorService(
      idempotencyStore,
      timeoutEnforcer,
      auditEmitter,
      () => currentTime,
    );
  });

  // ─── Successful Execution ──────────────────────────────────────────────

  describe('successful execution', () => {
    it('should execute action and return response', async () => {
      const request = createTestRequest();
      const executor = createSuccessExecutor(request);

      const response = await service.execute(request, executor);

      expect(response.outcome).toBe('SUCCESS');
      expect(response.action_id).toBe('action-1');
    });

    it('should emit action.started and action.completed audit events', async () => {
      const request = createTestRequest();
      const executor = createSuccessExecutor(request);

      await service.execute(request, executor);

      const categories = auditClient.events.map((e) => e.event_category);
      expect(categories).toContain('action.started');
      expect(categories).toContain('action.completed');
    });

    it('should cache result in idempotency store', async () => {
      const request = createTestRequest();
      const executor = createSuccessExecutor(request);

      await service.execute(request, executor);

      const cached = await idempotencyStore.get('idem-1');
      expect(cached).not.toBeNull();
      expect(cached!.response.outcome).toBe('SUCCESS');
    });
  });

  // ─── Idempotency ──────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('should return cached result for duplicate idempotency key', async () => {
      const request = createTestRequest();
      const executor = createSuccessExecutor(request);

      // First execution
      const response1 = await service.execute(request, executor);

      // Second execution with same idempotency key
      let executorCalled = false;
      const secondExecutor: ActionExecutorFn = async (req, _signal) => {
        executorCalled = true;
        return createSuccessResponse(req);
      };

      const response2 = await service.execute(request, secondExecutor);

      expect(executorCalled).toBe(false);
      expect(response2.outcome).toBe(response1.outcome);
      expect(response2.action_id).toBe(response1.action_id);
    });

    it('should emit idempotent_hit audit event for cached result', async () => {
      const request = createTestRequest();
      const executor = createSuccessExecutor(request);

      await service.execute(request, executor);
      auditClient.events.length = 0; // Clear events from first execution

      await service.execute(request, executor);

      const categories = auditClient.events.map((e) => e.event_category);
      expect(categories).toContain('action.idempotent_hit');
      // Should NOT have action.started for the duplicate
      expect(categories).not.toContain('action.started');
    });

    it('should not cache result for different idempotency keys', async () => {
      const request1 = createTestRequest({ idempotency_key: 'key-1' as IdempotencyKey });
      const request2 = createTestRequest({ idempotency_key: 'key-2' as IdempotencyKey });

      let callCount = 0;
      const executor: ActionExecutorFn = async (req, _signal) => {
        callCount++;
        return createSuccessResponse(req);
      };

      await service.execute(request1, executor);
      await service.execute(request2, executor);

      expect(callCount).toBe(2);
    });
  });

  // ─── Timeout ───────────────────────────────────────────────────────────

  describe('timeout enforcement', () => {
    it('should return TIMEOUT outcome when action exceeds timeout', async () => {
      const request = createTestRequest({ timeout_seconds: 0.05 }); // 50ms timeout
      const executor = createDelayedExecutor(5000); // Takes 5 seconds

      const response = await service.execute(request, executor);

      expect(response.outcome).toBe('TIMEOUT');
      expect(response.error?.code).toBe('ACTION_TIMEOUT');
    });

    it('should emit action.timeout audit event on timeout', async () => {
      const request = createTestRequest({ timeout_seconds: 0.05 });
      const executor = createDelayedExecutor(5000);

      await service.execute(request, executor);

      const categories = auditClient.events.map((e) => e.event_category);
      expect(categories).toContain('action.timeout');
    });

    it('should cache timeout result for idempotency', async () => {
      const request = createTestRequest({ timeout_seconds: 0.05 });
      const executor = createDelayedExecutor(5000);

      await service.execute(request, executor);

      const cached = await idempotencyStore.get('idem-1');
      expect(cached).not.toBeNull();
      expect(cached!.response.outcome).toBe('TIMEOUT');
    });

    it('should include timeout details in error response', async () => {
      const request = createTestRequest({ timeout_seconds: 0.05 });
      const executor = createDelayedExecutor(5000);

      const response = await service.execute(request, executor);

      expect(response.error?.details).toBeDefined();
      expect(response.error?.details?.timeout_seconds).toBe(0.05);
    });
  });

  // ─── Failed Execution ──────────────────────────────────────────────────

  describe('failed execution', () => {
    it('should emit action.failed audit event on failure', async () => {
      const request = createTestRequest();
      const executor = createFailingExecutor('Something went wrong');

      await service.execute(request, executor);

      const categories = auditClient.events.map((e) => e.event_category);
      expect(categories).toContain('action.failed');
    });

    it('should cache failure result for idempotency', async () => {
      const request = createTestRequest();
      const executor = createFailingExecutor('Something went wrong');

      await service.execute(request, executor);

      const cached = await idempotencyStore.get('idem-1');
      expect(cached).not.toBeNull();
      expect(cached!.response.outcome).toBe('FAILURE');
    });

    it('should preserve error details in response', async () => {
      const request = createTestRequest();
      const executor = createFailingExecutor('Disk full');

      const response = await service.execute(request, executor);

      expect(response.outcome).toBe('FAILURE');
      expect(response.error?.message).toBe('Disk full');
    });
  });

  // ─── Audit Event Ordering ─────────────────────────────────────────────

  describe('audit event ordering', () => {
    it('should emit started before completed for successful execution', async () => {
      const request = createTestRequest();
      const executor = createSuccessExecutor(request);

      await service.execute(request, executor);

      const categories = auditClient.events.map((e) => e.event_category);
      const startedIdx = categories.indexOf('action.started');
      const completedIdx = categories.indexOf('action.completed');

      expect(startedIdx).toBeLessThan(completedIdx);
    });

    it('should emit started before timeout for timed-out execution', async () => {
      const request = createTestRequest({ timeout_seconds: 0.05 });
      const executor = createDelayedExecutor(5000);

      await service.execute(request, executor);

      const categories = auditClient.events.map((e) => e.event_category);
      const startedIdx = categories.indexOf('action.started');
      const timeoutIdx = categories.indexOf('action.timeout');

      expect(startedIdx).toBeLessThan(timeoutIdx);
    });
  });
});
