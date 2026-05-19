/**
 * Unit tests for ModelRegistry — in-memory versioned model catalog.
 *
 * Verifies:
 * - CRUD operations (create, get, list, update, delete)
 * - Automatic versioning on mutations
 * - Timestamp management (created_at, updated_at)
 * - Filtering by provider, approval_status, capability_tag, residency_region
 * - Error handling for duplicate creates and missing updates
 *
 * @see Requirement 4.2 — versioned Model_Registry
 * @see Requirement 4.12 — dual-model architecture (local + cloud)
 * @see Requirement 4.13 — provider abstraction layer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRegistry } from '../src/model-registry.js';
import type {
  IClock,
  IIdGenerator,
  ModelRegistryCreateInput,
} from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private current = '2024-01-01T00:00:00.000Z';

  nowISO(): string {
    return this.current;
  }

  advance(iso: string): void {
    this.current = iso;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  version(): string {
    this.counter++;
    return `v${this.counter}`;
  }
}

function makeCreateInput(overrides?: Partial<ModelRegistryCreateInput>): ModelRegistryCreateInput {
  return {
    model_id: overrides?.model_id ?? 'model-1',
    provider: overrides?.provider ?? 'openai',
    identifier: overrides?.identifier ?? 'gpt-4o',
    capability_tags: overrides?.capability_tags ?? ['reasoning', 'code'],
    cost_coefficients: overrides?.cost_coefficients ?? {
      prompt_per_1k: 0.03,
      completion_per_1k: 0.06,
    },
    residency_constraints: overrides?.residency_constraints ?? ['us-east-1', 'eu-west-1'],
    approval_status: overrides?.approval_status ?? 'approved',
    fallback_chain: overrides?.fallback_chain ?? ['model-2', 'model-3'],
    circuit_breaker_config: overrides?.circuit_breaker_config ?? {
      error_threshold: 50,
      rolling_window_ms: 60000,
      cooldown_ms: 30000,
    },
    canary_config: overrides?.canary_config ?? {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 500 },
      auto_revert_threshold: 0.5,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ModelRegistry', () => {
  let clock: MockClock;
  let idGen: MockIdGenerator;
  let registry: ModelRegistry;

  beforeEach(() => {
    clock = new MockClock();
    idGen = new MockIdGenerator();
    registry = new ModelRegistry(clock, idGen);
  });

  describe('create', () => {
    it('creates a new entry with version and timestamps', async () => {
      const input = makeCreateInput();
      const result = await registry.create(input);

      expect(result.entry.model_id).toBe('model-1');
      expect(result.entry.provider).toBe('openai');
      expect(result.entry.identifier).toBe('gpt-4o');
      expect(result.entry.capability_tags).toEqual(['reasoning', 'code']);
      expect(result.entry.cost_coefficients).toEqual({ prompt_per_1k: 0.03, completion_per_1k: 0.06 });
      expect(result.entry.residency_constraints).toEqual(['us-east-1', 'eu-west-1']);
      expect(result.entry.approval_status).toBe('approved');
      expect(result.entry.version).toBe('v1');
      expect(result.entry.created_at).toBe('2024-01-01T00:00:00.000Z');
      expect(result.entry.updated_at).toBe('2024-01-01T00:00:00.000Z');
      expect(result.previous_version).toBeUndefined();
    });

    it('throws when creating a duplicate model_id', async () => {
      await registry.create(makeCreateInput());
      await expect(registry.create(makeCreateInput())).rejects.toThrow(
        'Model registry entry already exists: model-1',
      );
    });

    it('supports creating local provider entries', async () => {
      const input = makeCreateInput({
        model_id: 'local-model-1',
        provider: 'local-ollama',
        identifier: 'llama-3-8b',
        residency_constraints: ['tenant-local'],
        cost_coefficients: { prompt_per_1k: 0, completion_per_1k: 0 },
      });

      const result = await registry.create(input);
      expect(result.entry.provider).toBe('local-ollama');
      expect(result.entry.residency_constraints).toEqual(['tenant-local']);
      expect(result.entry.cost_coefficients.prompt_per_1k).toBe(0);
    });

    it('supports creating cloud provider entries', async () => {
      const input = makeCreateInput({
        model_id: 'cloud-model-1',
        provider: 'anthropic',
        identifier: 'claude-3-opus',
        residency_constraints: ['us-east-1'],
      });

      const result = await registry.create(input);
      expect(result.entry.provider).toBe('anthropic');
      expect(result.entry.identifier).toBe('claude-3-opus');
    });
  });

  describe('get', () => {
    it('returns null for non-existent model_id', async () => {
      const result = await registry.get('non-existent');
      expect(result).toBeNull();
    });

    it('returns the entry for an existing model_id', async () => {
      await registry.create(makeCreateInput());
      const result = await registry.get('model-1');

      expect(result).not.toBeNull();
      expect(result!.model_id).toBe('model-1');
      expect(result!.provider).toBe('openai');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await registry.create(makeCreateInput({ model_id: 'openai-1', provider: 'openai', approval_status: 'approved', capability_tags: ['reasoning', 'code'], residency_constraints: ['us-east-1'] }));
      await registry.create(makeCreateInput({ model_id: 'anthropic-1', provider: 'anthropic', approval_status: 'approved', capability_tags: ['reasoning', 'vision'], residency_constraints: ['eu-west-1'] }));
      await registry.create(makeCreateInput({ model_id: 'local-1', provider: 'local-ollama', approval_status: 'pending', capability_tags: ['code'], residency_constraints: ['tenant-local'] }));
    });

    it('returns all entries when no filter is provided', async () => {
      const results = await registry.list();
      expect(results).toHaveLength(3);
    });

    it('filters by provider', async () => {
      const results = await registry.list({ provider: 'openai' });
      expect(results).toHaveLength(1);
      expect(results[0].model_id).toBe('openai-1');
    });

    it('filters by approval_status', async () => {
      const results = await registry.list({ approval_status: 'pending' });
      expect(results).toHaveLength(1);
      expect(results[0].model_id).toBe('local-1');
    });

    it('filters by capability_tag', async () => {
      const results = await registry.list({ capability_tag: 'reasoning' });
      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.model_id);
      expect(ids).toContain('openai-1');
      expect(ids).toContain('anthropic-1');
    });

    it('filters by residency_region', async () => {
      const results = await registry.list({ residency_region: 'tenant-local' });
      expect(results).toHaveLength(1);
      expect(results[0].model_id).toBe('local-1');
    });

    it('returns empty array when no entries match filter', async () => {
      const results = await registry.list({ provider: 'non-existent' });
      expect(results).toHaveLength(0);
    });

    it('combines multiple filters', async () => {
      const results = await registry.list({ provider: 'openai', capability_tag: 'code' });
      expect(results).toHaveLength(1);
      expect(results[0].model_id).toBe('openai-1');
    });
  });

  describe('update', () => {
    it('updates fields and increments version', async () => {
      await registry.create(makeCreateInput());
      clock.advance('2024-01-02T00:00:00.000Z');

      const result = await registry.update('model-1', {
        approval_status: 'deprecated',
      });

      expect(result.entry.approval_status).toBe('deprecated');
      expect(result.entry.version).toBe('v2');
      expect(result.entry.updated_at).toBe('2024-01-02T00:00:00.000Z');
      expect(result.entry.created_at).toBe('2024-01-01T00:00:00.000Z');
      expect(result.previous_version).toBe('v1');
    });

    it('preserves unchanged fields', async () => {
      await registry.create(makeCreateInput());
      const result = await registry.update('model-1', { provider: 'anthropic' });

      expect(result.entry.provider).toBe('anthropic');
      expect(result.entry.identifier).toBe('gpt-4o');
      expect(result.entry.capability_tags).toEqual(['reasoning', 'code']);
      expect(result.entry.model_id).toBe('model-1');
    });

    it('throws when updating a non-existent entry', async () => {
      await expect(registry.update('non-existent', { provider: 'x' })).rejects.toThrow(
        'Model registry entry not found: non-existent',
      );
    });

    it('supports multiple sequential updates with incrementing versions', async () => {
      await registry.create(makeCreateInput());
      clock.advance('2024-01-02T00:00:00.000Z');
      await registry.update('model-1', { approval_status: 'pending' });
      clock.advance('2024-01-03T00:00:00.000Z');
      const result = await registry.update('model-1', { approval_status: 'approved' });

      expect(result.entry.version).toBe('v3');
      expect(result.previous_version).toBe('v2');
      expect(result.entry.updated_at).toBe('2024-01-03T00:00:00.000Z');
    });

    it('updates cost_coefficients', async () => {
      await registry.create(makeCreateInput());
      const result = await registry.update('model-1', {
        cost_coefficients: { prompt_per_1k: 0.01, completion_per_1k: 0.02 },
      });

      expect(result.entry.cost_coefficients).toEqual({ prompt_per_1k: 0.01, completion_per_1k: 0.02 });
    });

    it('updates capability_tags', async () => {
      await registry.create(makeCreateInput());
      const result = await registry.update('model-1', {
        capability_tags: ['vision', 'function_calling'],
      });

      expect(result.entry.capability_tags).toEqual(['vision', 'function_calling']);
    });
  });

  describe('delete', () => {
    it('returns false for non-existent model_id', async () => {
      const result = await registry.delete('non-existent');
      expect(result).toBe(false);
    });

    it('deletes an existing entry and returns true', async () => {
      await registry.create(makeCreateInput());
      const result = await registry.delete('model-1');
      expect(result).toBe(true);

      const entry = await registry.get('model-1');
      expect(entry).toBeNull();
    });

    it('entry is no longer listed after deletion', async () => {
      await registry.create(makeCreateInput());
      await registry.delete('model-1');

      const results = await registry.list();
      expect(results).toHaveLength(0);
    });
  });

  describe('dual-model architecture support', () => {
    it('supports both local and cloud models in the same registry', async () => {
      await registry.create(makeCreateInput({
        model_id: 'cloud-gpt4',
        provider: 'openai',
        identifier: 'gpt-4o',
        residency_constraints: ['us-east-1', 'eu-west-1'],
        cost_coefficients: { prompt_per_1k: 0.03, completion_per_1k: 0.06 },
      }));

      await registry.create(makeCreateInput({
        model_id: 'local-llama',
        provider: 'local-ollama',
        identifier: 'llama-3-8b',
        residency_constraints: ['tenant-local'],
        cost_coefficients: { prompt_per_1k: 0, completion_per_1k: 0 },
      }));

      const all = await registry.list();
      expect(all).toHaveLength(2);

      const localModels = await registry.list({ residency_region: 'tenant-local' });
      expect(localModels).toHaveLength(1);
      expect(localModels[0].provider).toBe('local-ollama');

      const cloudModels = await registry.list({ provider: 'openai' });
      expect(cloudModels).toHaveLength(1);
      expect(cloudModels[0].cost_coefficients.prompt_per_1k).toBeGreaterThan(0);
    });
  });
});
