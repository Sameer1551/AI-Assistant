/**
 * Property-Based Tests — Workflow Service
 *
 * Property 31: Workflow State Persistence — state persisted before proceeding
 * Property 32: Workflow Step Retry with Exponential Backoff — correct formula
 * Property 33: Workflow Concurrency Limit — new workflows rejected at max concurrent
 *
 * @see Requirements 8.1, 8.4, 8.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowService } from '../src/workflow-service.js';
import { InMemoryWorkflowStore } from '../src/in-memory-workflow-store.js';
import { computeBackoffDelay } from '../src/backoff.js';
import { isValidDAG } from '../src/dependency-graph.js';
import type { RetryPolicy } from '@may/types';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const mockAudit = { emit: async () => {} };
let idCounter = 0;
const mockIdGen = { uuid: () => `wf-${++idCounter}` };
const mockClock = { nowISO: () => new Date('2025-01-15T10:00:00Z').toISOString() };

const baseStep = {
  step_id: 'step-1',
  name: 'Test Step',
  action_type: 'test.action',
  parameters: {},
  dependencies: [] as string[],
  timeout_seconds: 60,
  retry_policy: { max_retries: 3, initial_backoff_ms: 1000, max_backoff_ms: 30000, backoff_multiplier: 2 } satisfies RetryPolicy,
  requires_confirmation: false,
};

function makeService(store?: InMemoryWorkflowStore, maxConcurrent = 3) {
  return new WorkflowService({
    store: store ?? new InMemoryWorkflowStore(),
    auditEmitter: mockAudit,
    idGenerator: mockIdGen,
    clock: mockClock,
    maxConcurrentPerTenant: maxConcurrent,
  });
}

// ─── Property 31: Workflow State Persistence ──────────────────────────────────

describe('Property 31: Workflow State Persistence', () => {
  it('workflow is persisted immediately after creation', async () => {
    const store = new InMemoryWorkflowStore();
    const service = makeService(store);

    const { workflow_id } = await service.createWorkflow({
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      name: 'Test Workflow',
      steps: [baseStep],
    });

    // Must be findable in store immediately (state persisted before returning)
    const found = await store.findById(workflow_id, 'tenant-1');
    expect(found).not.toBeNull();
    expect(found!.status).toBe('CREATED');
  });

  it('pause persists PAUSED state before returning', async () => {
    const store = new InMemoryWorkflowStore();
    const service = makeService(store);

    const { workflow_id } = await service.createWorkflow({
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      name: 'Workflow',
      steps: [baseStep],
    });

    // Manually set to RUNNING
    const created = await store.findById(workflow_id, 'tenant-1');
    await store.update({ ...created!, status: 'RUNNING' });

    await service.pauseWorkflow(workflow_id, 'tenant-1');
    const persisted = await store.findById(workflow_id, 'tenant-1');
    expect(persisted!.status).toBe('PAUSED');
  });

  it('cancel persists CANCELLED state before returning', async () => {
    const store = new InMemoryWorkflowStore();
    const service = makeService(store);

    const { workflow_id } = await service.createWorkflow({
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      name: 'Workflow',
      steps: [baseStep],
    });

    await service.cancelWorkflow(workflow_id, 'tenant-1');
    const persisted = await store.findById(workflow_id, 'tenant-1');
    expect(persisted!.status).toBe('CANCELLED');
    expect(persisted!.completed_at).toBeDefined();
  });
});

// ─── Property 32: Exponential Backoff Formula ────────────────────────────────

describe('Property 32: Workflow Step Retry with Exponential Backoff', () => {
  const policy: RetryPolicy = {
    max_retries: 5,
    initial_backoff_ms: 100,
    max_backoff_ms: 5000,
    backoff_multiplier: 2,
  };

  it('attempt 1 returns initial_backoff_ms', () => {
    expect(computeBackoffDelay(policy, 1)).toBe(100);
  });

  it('attempt 2 returns initial × multiplier^1', () => {
    expect(computeBackoffDelay(policy, 2)).toBe(200);
  });

  it('attempt 3 returns initial × multiplier^2', () => {
    expect(computeBackoffDelay(policy, 3)).toBe(400);
  });

  it('delay is capped at max_backoff_ms', () => {
    // attempt 10: 100 × 2^9 = 51200 → capped at 5000
    expect(computeBackoffDelay(policy, 10)).toBe(5000);
  });

  it('formula: delay = initial × multiplier^(attempt-1), capped at max', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const raw = policy.initial_backoff_ms * Math.pow(policy.backoff_multiplier, attempt - 1);
      const expected = Math.min(raw, policy.max_backoff_ms);
      expect(computeBackoffDelay(policy, attempt)).toBeCloseTo(expected, 5);
    }
  });

  it('delay is always positive', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(computeBackoffDelay(policy, attempt)).toBeGreaterThan(0);
    }
  });
});

// ─── Property 33: Workflow Concurrency Limit ──────────────────────────────────

describe('Property 33: Workflow Concurrency Limit', () => {
  it('new workflow rejected with backpressure error when max concurrent reached', async () => {
    const store = new InMemoryWorkflowStore();
    const maxConcurrent = 2;
    const service = makeService(store, maxConcurrent);

    // Create workflows up to the limit
    await service.createWorkflow({ tenant_id: 'tenant-1', principal_id: 'u1', name: 'W1', steps: [baseStep] });
    await service.createWorkflow({ tenant_id: 'tenant-1', principal_id: 'u1', name: 'W2', steps: [baseStep] });

    // Next one must be rejected
    await expect(
      service.createWorkflow({ tenant_id: 'tenant-1', principal_id: 'u1', name: 'W3', steps: [baseStep] }),
    ).rejects.toThrow('BACKPRESSURE');
  });

  it('different tenants do not share concurrency limits', async () => {
    const store = new InMemoryWorkflowStore();
    const service = makeService(store, 1);

    await service.createWorkflow({ tenant_id: 'tenant-A', principal_id: 'u1', name: 'W1', steps: [baseStep] });

    // tenant-B should succeed even though tenant-A is at limit
    await expect(
      service.createWorkflow({ tenant_id: 'tenant-B', principal_id: 'u2', name: 'W2', steps: [baseStep] }),
    ).resolves.toBeDefined();
  });
});

// ─── Dependency Graph / Cycle Detection ──────────────────────────────────────

describe('Dependency cycle detection', () => {
  it('rejects workflow with a direct cycle (A→B→A)', async () => {
    const service = makeService();
    const steps = [
      { step_id: 'A', dependencies: ['B'] },
      { step_id: 'B', dependencies: ['A'] },
    ];
    expect(service.validateDependencyGraph(steps)).toBe(false);
  });

  it('rejects workflow with a transitive cycle (A→B→C→A)', async () => {
    const service = makeService();
    const steps = [
      { step_id: 'A', dependencies: ['C'] },
      { step_id: 'B', dependencies: ['A'] },
      { step_id: 'C', dependencies: ['B'] },
    ];
    expect(service.validateDependencyGraph(steps)).toBe(false);
  });

  it('accepts a valid linear chain (A→B→C)', async () => {
    const service = makeService();
    const steps = [
      { step_id: 'A', dependencies: [] },
      { step_id: 'B', dependencies: ['A'] },
      { step_id: 'C', dependencies: ['B'] },
    ];
    expect(service.validateDependencyGraph(steps)).toBe(true);
  });

  it('isValidDAG standalone: diamond dependency (A→B, A→C, B→D, C→D)', () => {
    expect(isValidDAG([
      { step_id: 'A', dependencies: [] },
      { step_id: 'B', dependencies: ['A'] },
      { step_id: 'C', dependencies: ['A'] },
      { step_id: 'D', dependencies: ['B', 'C'] },
    ])).toBe(true);
  });
});
