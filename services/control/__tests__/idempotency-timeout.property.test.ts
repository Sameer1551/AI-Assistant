/**
 * Property-based tests for idempotency and timeout enforcement.
 *
 * **Validates: Requirements 2.7, 2.8**
 *
 * Property 3: Action Idempotency — For any action request submitted with the
 *   same idempotency key within the 24-hour deduplication window, the system
 *   must return the previously-recorded outcome without re-executing the action.
 *
 * Property 4: Action Timeout Enforcement — For any action with a configured
 *   timeout, if the action execution exceeds the timeout duration, the system
 *   must terminate the action and return a TIMEOUT outcome.
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@may/testing';
import type { ActionRequest, ActionResponse, ActionOutcome } from '@may/types';
import type { ActionId, IdempotencyKey, CorrelationId, TenantId, PrincipalId, SessionId } from '@may/types';
import { InMemoryIdempotencyStore } from '../src/in-memory-idempotency-store.js';
import { TimeoutEnforcer } from '../src/timeout-enforcer.js';
import { ActionExecutorService } from '../src/action-executor-service.js';
import { ActionAuditEmitter } from '../src/action-audit-emitter.js';
import type { ActionExecutorFn } from '../src/interfaces/index.js';
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

class StubAuditClient {
  readonly events: IngestedEvent[] = [];
  private eventCounter = 0;

  async ingest(event: IngestedEvent): Promise<{ event_id: string }> {
    this.events.push(event);
    this.eventCounter++;
    return { event_id: `audit-${this.eventCounter}` };
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for idempotency keys. */
const idempotencyKeyArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
  { minLength: 5, maxLength: 30 },
).map((s) => `idem-${s}` as unknown as IdempotencyKey);

/** Arbitrary for action IDs. */
const actionIdArb = fc.uuid().map((s) => s as unknown as ActionId);

/** Arbitrary for action outcomes (non-TIMEOUT). */
const actionOutcomeArb = fc.constantFrom<ActionOutcome>('SUCCESS', 'FAILURE', 'CANCELLED', 'DENIED');

/** Arbitrary for timeout values within the valid range [1, 600]. */
const timeoutSecondsArb = fc.integer({ min: 1, max: 600 });

/** Arbitrary for action types. */
const actionTypeArb = fc.constantFrom(
  'file.read', 'file.write', 'file.delete',
  'browser.navigate', 'browser.click',
  'shell.execute', 'api.call',
);

/** Arbitrary for risk levels. */
const riskLevelArb = fc.constantFrom<'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>(
  'SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL',
);

/** Arbitrary for a valid ActionRequest. */
const actionRequestArb = fc.record({
  action_id: actionIdArb,
  idempotency_key: idempotencyKeyArb,
  risk_level: riskLevelArb,
  action_type: actionTypeArb,
  timeout_seconds: timeoutSecondsArb,
}).map((fields) => ({
  ...fields,
  parameters: { path: '/tmp/test.txt' },
  context: {
    tenant_id: 'tenant-1' as unknown as TenantId,
    principal_id: 'user-1' as unknown as PrincipalId,
    correlation_id: 'corr-1' as unknown as CorrelationId,
    trace_context: { traceparent: '00-trace-span-01' },
    session_id: 'session-1' as unknown as SessionId,
    roles: ['End_User'],
    attributes: {},
    residency_region: 'us-east-1',
  },
} as ActionRequest));

/** Arbitrary for time offsets within the 24h window (in ms), strictly less than 24h. */
const withinWindowOffsetArb = fc.integer({ min: 0, max: 23 * 60 * 60 * 1000 });

/** Arbitrary for time offsets beyond the 24h window (in ms). */
const beyondWindowOffsetArb = fc.integer({ min: 24 * 60 * 60 * 1000 + 1, max: 48 * 60 * 60 * 1000 });

// ─── Property 3: Action Idempotency ─────────────────────────────────────────

describe('Property 3: Action Idempotency', () => {
  /**
   * **Validates: Requirements 2.7**
   *
   * For any action request submitted with the same idempotency key within
   * the 24-hour deduplication window, the system must return the previously-
   * recorded outcome without re-executing the action.
   */
  it('returns cached outcome without re-execution for same idempotency key within 24h', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        actionOutcomeArb,
        async (request, outcome) => {
          const currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);

          // Simulate storing a result
          const cachedResponse: ActionResponse = {
            action_id: request.action_id,
            idempotency_key: request.idempotency_key,
            outcome,
            duration_ms: 50,
            audit_event_id: 'audit-1',
            correlation_id: request.context.correlation_id as CorrelationId,
          };

          // Store the result
          await store.set(request.idempotency_key as string, cachedResponse);

          // Retrieve within the 24h window — should return cached result
          const cached = await store.get(request.idempotency_key as string);
          expect(cached).not.toBeNull();
          expect(cached!.response.outcome).toBe(outcome);
          expect(cached!.response.action_id).toBe(request.action_id);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('does not re-execute action when idempotency key is found in cache', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        async (request) => {
          const currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);
          const timeoutEnforcer = new TimeoutEnforcer();
          const auditClient = new StubAuditClient();
          const auditEmitter = new ActionAuditEmitter(auditClient as any, () => currentTime);
          const service = new ActionExecutorService(
            store,
            timeoutEnforcer,
            auditEmitter,
            () => currentTime,
          );

          let executionCount = 0;
          const executor: ActionExecutorFn = async (req, _signal) => {
            executionCount++;
            return {
              action_id: req.action_id,
              idempotency_key: req.idempotency_key,
              outcome: 'SUCCESS' as ActionOutcome,
              duration_ms: 10,
              audit_event_id: 'audit-1',
              correlation_id: req.context.correlation_id as CorrelationId,
            };
          };

          // First execution
          const response1 = await service.execute(request, executor);
          expect(executionCount).toBe(1);

          // Second execution with same idempotency key — should NOT re-execute
          const response2 = await service.execute(request, executor);
          expect(executionCount).toBe(1); // Still 1 — not re-executed
          expect(response2.outcome).toBe(response1.outcome);
          expect(response2.action_id).toBe(response1.action_id);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('expires cached results after 24-hour deduplication window', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        beyondWindowOffsetArb,
        async (request, offset) => {
          let currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);

          const cachedResponse: ActionResponse = {
            action_id: request.action_id,
            idempotency_key: request.idempotency_key,
            outcome: 'SUCCESS',
            duration_ms: 50,
            audit_event_id: 'audit-1',
            correlation_id: request.context.correlation_id as CorrelationId,
          };

          // Store the result at current time
          await store.set(request.idempotency_key as string, cachedResponse);

          // Advance time beyond the 24h window
          currentTime += offset;

          // Should return null — entry has expired
          const cached = await store.get(request.idempotency_key as string);
          expect(cached).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('returns cached result for any time within the 24h window', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        withinWindowOffsetArb,
        async (request, offset) => {
          let currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);

          const cachedResponse: ActionResponse = {
            action_id: request.action_id,
            idempotency_key: request.idempotency_key,
            outcome: 'SUCCESS',
            duration_ms: 50,
            audit_event_id: 'audit-1',
            correlation_id: request.context.correlation_id as CorrelationId,
          };

          // Store the result at current time
          await store.set(request.idempotency_key as string, cachedResponse);

          // Advance time within the 24h window
          currentTime += offset;

          // Should still return the cached result
          const cached = await store.get(request.idempotency_key as string);
          expect(cached).not.toBeNull();
          expect(cached!.response.outcome).toBe('SUCCESS');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('different idempotency keys are independent', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        actionRequestArb,
        async (request1, request2) => {
          // Ensure different idempotency keys
          fc.pre(request1.idempotency_key !== request2.idempotency_key);

          const currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);
          const timeoutEnforcer = new TimeoutEnforcer();
          const auditClient = new StubAuditClient();
          const auditEmitter = new ActionAuditEmitter(auditClient as any, () => currentTime);
          const service = new ActionExecutorService(
            store,
            timeoutEnforcer,
            auditEmitter,
            () => currentTime,
          );

          let executionCount = 0;
          const executor: ActionExecutorFn = async (req, _signal) => {
            executionCount++;
            return {
              action_id: req.action_id,
              idempotency_key: req.idempotency_key,
              outcome: 'SUCCESS' as ActionOutcome,
              duration_ms: 10,
              audit_event_id: `audit-${executionCount}`,
              correlation_id: req.context.correlation_id as CorrelationId,
            };
          };

          // Execute both requests — both should execute since keys differ
          await service.execute(request1, executor);
          await service.execute(request2, executor);

          expect(executionCount).toBe(2);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 4: Action Timeout Enforcement ──────────────────────────────────

describe('Property 4: Action Timeout Enforcement', () => {
  /**
   * **Validates: Requirements 2.8**
   *
   * For any action with a configured timeout, if the action execution exceeds
   * the timeout duration, the system must terminate the action and return a
   * TIMEOUT outcome.
   */
  it('terminates action with TIMEOUT when execution exceeds configured timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        async (request) => {
          // Use a custom TimeoutEnforcer with a very short min to allow sub-second timeouts
          const enforcer = new TimeoutEnforcer({ min_seconds: 0.01, max_seconds: 600, default_seconds: 60 });

          const timeoutSec = 0.05; // 50ms timeout
          const operationDuration = 200; // 200ms — exceeds timeout

          const operation = (signal: AbortSignal) =>
            new Promise<ActionResponse>((resolve, reject) => {
              const timer = setTimeout(() => {
                resolve({
                  action_id: request.action_id,
                  idempotency_key: request.idempotency_key,
                  outcome: 'SUCCESS',
                  duration_ms: operationDuration,
                  audit_event_id: 'audit-1',
                  correlation_id: request.context.correlation_id as CorrelationId,
                });
              }, operationDuration);

              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
              });
            });

          // Execute with a timeout shorter than the operation
          const result = await enforcer.executeWithTimeout(operation, timeoutSec);

          // Must not complete — timeout should have triggered
          expect(result.completed).toBe(false);
          expect(result.elapsed_ms).toBeDefined();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('returns TIMEOUT outcome through ActionExecutorService on timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        async (request) => {
          const currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);
          // Use a custom TimeoutEnforcer that allows sub-second timeouts
          const timeoutEnforcer = new TimeoutEnforcer({ min_seconds: 0.01, max_seconds: 600, default_seconds: 60 });
          const auditClient = new StubAuditClient();
          const auditEmitter = new ActionAuditEmitter(auditClient as any, () => currentTime);
          const service = new ActionExecutorService(
            store,
            timeoutEnforcer,
            auditEmitter,
            () => currentTime,
          );

          // Override timeout to a very short value for testing
          const shortTimeoutRequest = {
            ...request,
            timeout_seconds: 0.05, // 50ms
          } as ActionRequest;

          // Executor that takes longer than the timeout
          const executor: ActionExecutorFn = async (req, signal) => {
            return new Promise<ActionResponse>((resolve, reject) => {
              const timer = setTimeout(() => {
                resolve({
                  action_id: req.action_id,
                  idempotency_key: req.idempotency_key,
                  outcome: 'SUCCESS' as ActionOutcome,
                  duration_ms: 5000,
                  audit_event_id: 'audit-1',
                  correlation_id: req.context.correlation_id as CorrelationId,
                });
              }, 500); // 500ms — exceeds 50ms timeout

              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
              });
            });
          };

          const response = await service.execute(shortTimeoutRequest, executor);

          // Must return TIMEOUT outcome
          expect(response.outcome).toBe('TIMEOUT');
          expect(response.error?.code).toBe('ACTION_TIMEOUT');
        },
      ),
      { numRuns: 20 },
    );
  }, 30000);

  it('emits audit event with TIMEOUT outcome on timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        async (request) => {
          const currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
          const store = new InMemoryIdempotencyStore(() => currentTime);
          const timeoutEnforcer = new TimeoutEnforcer({ min_seconds: 0.01, max_seconds: 600, default_seconds: 60 });
          const auditClient = new StubAuditClient();
          const auditEmitter = new ActionAuditEmitter(auditClient as any, () => currentTime);
          const service = new ActionExecutorService(
            store,
            timeoutEnforcer,
            auditEmitter,
            () => currentTime,
          );

          const shortTimeoutRequest = {
            ...request,
            timeout_seconds: 0.05, // 50ms
          } as ActionRequest;

          const executor: ActionExecutorFn = async (req, signal) => {
            return new Promise<ActionResponse>((resolve, reject) => {
              const timer = setTimeout(() => {
                resolve({
                  action_id: req.action_id,
                  idempotency_key: req.idempotency_key,
                  outcome: 'SUCCESS' as ActionOutcome,
                  duration_ms: 5000,
                  audit_event_id: 'audit-1',
                  correlation_id: req.context.correlation_id as CorrelationId,
                });
              }, 500); // 500ms — exceeds 50ms timeout

              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
              });
            });
          };

          await service.execute(shortTimeoutRequest, executor);

          // Must have emitted an action.timeout audit event
          const timeoutEvents = auditClient.events.filter(
            (e) => e.event_category === 'action.timeout',
          );
          expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
          expect(timeoutEvents[0].outcome).toBe('TIMEOUT');
        },
      ),
      { numRuns: 20 },
    );
  }, 30000);

  it('validates timeout is clamped to [1, 600] range', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1000, max: 0 }),    // Below minimum
          fc.integer({ min: 601, max: 10000 }),   // Above maximum
          fc.constant(NaN),                        // Invalid
          fc.constant(Infinity),                   // Invalid
          fc.constant(-Infinity),                  // Invalid
        ),
        (invalidTimeout) => {
          const enforcer = new TimeoutEnforcer();
          const validated = enforcer.validateTimeout(invalidTimeout);

          // Must be clamped to valid range or use default
          expect(validated).toBeGreaterThanOrEqual(1);
          expect(validated).toBeLessThanOrEqual(600);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('completes successfully when action finishes within timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionRequestArb,
        async (request) => {
          const timeoutEnforcer = new TimeoutEnforcer();

          // Operation that completes instantly (well within any timeout)
          const operation = async (_signal: AbortSignal): Promise<ActionResponse> => ({
            action_id: request.action_id,
            idempotency_key: request.idempotency_key,
            outcome: 'SUCCESS',
            duration_ms: 1,
            audit_event_id: 'audit-1',
            correlation_id: request.context.correlation_id as CorrelationId,
          });

          // Use the request's timeout (1-600s) — operation is instant
          const result = await timeoutEnforcer.executeWithTimeout(operation, request.timeout_seconds);

          // Must complete successfully
          expect(result.completed).toBe(true);
          expect(result.result).toBeDefined();
          expect(result.result!.outcome).toBe('SUCCESS');
        },
      ),
      { numRuns: 50 },
    );
  });
});
