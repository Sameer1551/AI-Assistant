/**
 * Property-Based Tests — Memory Service
 *
 * Property 7:  Tenant Data Isolation — queries return only records matching authenticated tenant_id
 * Property 21: Memory Serialization Safety — only JSON/safe formats, no code-executing serializers
 * Property 22: Memory Retrieval Constraints — results capped, ordered by relevance, include provenance
 * Property 67: Temporal Memory Half-Life Decay — at one half-life age, score reduced by 50%
 * Property 68: Memory Frequency Boost Cap — boost increases with access count but never exceeds max
 * Property 69: Memory Priority and Intent Resonance Boost — correct multipliers applied
 *
 * @see Requirements 5.2, 5.3, 5.5, 43.2, 43.3, 43.4, 43.5
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryService } from '../src/memory-service.js';
import { InMemoryMemoryStore } from '../src/in-memory-store.js';
import {
  computeTemporalDecay,
  computeFrequencyBoost,
  computePriorityBoost,
  computeIntentResonanceBoost,
} from '../src/temporal-weighting.js';
import { DEFAULT_WEIGHTING_CONFIG } from '../src/interfaces/index.js';
import type { MemoryWeightingConfig } from '../src/interfaces/index.js';
import type { Provenance } from '@may/types';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const mockRedactor = {
  async redact(content: string, _tenantId: string) {
    return { redacted_content: content, classification: 'internal' as const };
  },
};

const mockEmbedding = {
  async embed(_text: string) {
    return { vector: [0.5, 0.5, 0.5] as readonly number[], model_version: 'test-v1' };
  },
  similarity(a: readonly number[], b: readonly number[]): number {
    // Simple dot product similarity for test
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return Math.min(1, Math.max(0, dot));
  },
};

let idCounter = 0;
const mockIdGenerator = { uuid: () => `test-id-${++idCounter}` };

const mockClock = {
  nowISO: () => new Date('2025-01-01T12:00:00Z').toISOString(),
  nowMs: () => new Date('2025-01-01T12:00:00Z').getTime(),
};

const mockAudit = { emit: async () => {} };

const makeProvenance = (): Provenance => ({
  source_service: 'test',
  source_action: 'test.write',
  correlation_id: 'corr-1',
  timestamp: mockClock.nowISO(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeService(store?: InMemoryMemoryStore) {
  return new MemoryService({
    store: store ?? new InMemoryMemoryStore(),
    redactor: mockRedactor,
    embedding: mockEmbedding,
    idGenerator: mockIdGenerator,
    clock: mockClock,
    auditEmitter: mockAudit,
  });
}

// ─── Property 7: Tenant Data Isolation ───────────────────────────────────────

describe('Property 7: Tenant Data Isolation', () => {
  it('queries for tenantA never return records belonging to tenantB', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    // Write records for tenantA
    await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Episodic_Memory', content: '{"text":"hello"}' },
      makeProvenance(),
    );

    // Write records for tenantB
    await service.write(
      { tenant_id: 'tenantB', principal_id: 'user2', layer: 'Episodic_Memory', content: '{"text":"world"}' },
      makeProvenance(),
    );

    const result = await service.query({
      tenant_id: 'tenantA',
      principal_id: 'user1',
    });

    // All returned records must belong exclusively to tenantA
    for (const scored of result.records) {
      expect(scored.record.tenant_id).toBe('tenantA');
    }
    expect(result.records.length).toBe(1);
  });

  it('principal isolation: user1 records not visible to user2 in same tenant', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Working_Memory', content: '{"text":"private"}' },
      makeProvenance(),
    );
    await service.write(
      { tenant_id: 'tenantA', principal_id: 'user2', layer: 'Working_Memory', content: '{"text":"other"}' },
      makeProvenance(),
    );

    const result = await service.query({ tenant_id: 'tenantA', principal_id: 'user1' });

    for (const scored of result.records) {
      expect(scored.record.principal_id).toBe('user1');
    }
    expect(result.records.length).toBe(1);
  });
});

// ─── Property 21: Memory Serialization Safety ────────────────────────────────

describe('Property 21: Memory Serialization Safety', () => {
  it('stores content as JSON-safe string regardless of input format', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    const response = await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Semantic_Memory', content: '{"key":"value"}' },
      makeProvenance(),
    );

    const queried = await service.query({ tenant_id: 'tenantA', principal_id: 'user1' });
    const found = queried.records.find((r) => r.record.record_id === response.record_id);
    expect(found).toBeDefined();

    // Content must be parseable JSON
    expect(() => JSON.parse(found!.record.content)).not.toThrow();
  });

  it('wraps plain-text content in a JSON envelope', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    const response = await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Semantic_Memory', content: 'plain text content' },
      makeProvenance(),
    );

    const queried = await service.query({ tenant_id: 'tenantA', principal_id: 'user1' });
    const found = queried.records.find((r) => r.record.record_id === response.record_id);
    expect(found).toBeDefined();

    // Should be valid JSON with a text wrapper
    const parsed = JSON.parse(found!.record.content);
    expect(parsed).toHaveProperty('text');
  });
});

// ─── Property 22: Memory Retrieval Constraints ───────────────────────────────

describe('Property 22: Memory Retrieval Constraints', () => {
  it('results are capped at max_results', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    // Write 10 records
    for (let i = 0; i < 10; i++) {
      await service.write(
        { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Episodic_Memory', content: `{"i":${i}}` },
        makeProvenance(),
      );
    }

    const result = await service.query({ tenant_id: 'tenantA', principal_id: 'user1', max_results: 3 });
    expect(result.records.length).toBeLessThanOrEqual(3);
    expect(result.total_searched).toBe(10);
  });

  it('results are ordered by composite score descending', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Episodic_Memory', content: '{"a":1}' },
      makeProvenance(),
    );
    await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Episodic_Memory', content: '{"b":2}' },
      makeProvenance(),
    );

    const result = await service.query({ tenant_id: 'tenantA', principal_id: 'user1' });
    for (let i = 1; i < result.records.length; i++) {
      expect(result.records[i - 1]!.composite_score).toBeGreaterThanOrEqual(
        result.records[i]!.composite_score,
      );
    }
  });

  it('all returned records include provenance metadata', async () => {
    const store = new InMemoryMemoryStore();
    const service = makeService(store);

    await service.write(
      { tenant_id: 'tenantA', principal_id: 'user1', layer: 'Working_Memory', content: '{"x":1}' },
      makeProvenance(),
    );

    const result = await service.query({ tenant_id: 'tenantA', principal_id: 'user1' });
    for (const scored of result.records) {
      expect(scored.record.provenance).toBeDefined();
      expect(scored.record.provenance.source_service).toBeTruthy();
      expect(scored.record.provenance.correlation_id).toBeTruthy();
    }
  });
});

// ─── Property 67: Temporal Memory Half-Life Decay ────────────────────────────

describe('Property 67: Temporal Memory Half-Life Decay', () => {
  it('at exactly one half-life age, temporal decay factor is 0.5 (±0.001)', () => {
    const layers = ['Working_Memory', 'Episodic_Memory', 'Semantic_Memory', 'Procedural_Memory', 'Knowledge_Graph_Memory'] as const;
    const config = DEFAULT_WEIGHTING_CONFIG;

    for (const layer of layers) {
      const halfLifeDays = config.half_life_days[layer];
      const now = new Date('2025-06-01T00:00:00Z');
      // Set created_at to exactly one half-life ago
      const createdAt = new Date(now.getTime() - halfLifeDays * 24 * 60 * 60 * 1000).toISOString();

      const factor = computeTemporalDecay(layer, createdAt, config, now);
      expect(factor).toBeCloseTo(0.5, 3);
    }
  });

  it('brand-new record has temporal decay factor of 1.0', () => {
    const now = new Date('2025-06-01T00:00:00Z');
    const factor = computeTemporalDecay('Episodic_Memory', now.toISOString(), DEFAULT_WEIGHTING_CONFIG, now);
    expect(factor).toBeCloseTo(1.0, 3);
  });
});

// ─── Property 68: Memory Frequency Boost Cap ─────────────────────────────────

describe('Property 68: Memory Frequency Boost Cap', () => {
  it('frequency boost never exceeds the configured maximum', () => {
    const config: MemoryWeightingConfig = { ...DEFAULT_WEIGHTING_CONFIG, frequency_boost_max: 1.3 };

    for (const count of [0, 1, 5, 10, 100, 1000, 10_000]) {
      const boost = computeFrequencyBoost(count, config);
      expect(boost).toBeLessThanOrEqual(config.frequency_boost_max + 0.001);
    }
  });

  it('frequency boost increases as access count increases (monotonic)', () => {
    const config = DEFAULT_WEIGHTING_CONFIG;
    let prev = computeFrequencyBoost(0, config);

    for (const count of [1, 5, 20, 100]) {
      const current = computeFrequencyBoost(count, config);
      expect(current).toBeGreaterThanOrEqual(prev);
      prev = current;
    }
  });

  it('frequency boost is at least 1.0 for any non-negative access count', () => {
    for (const count of [0, 1, 5, 100]) {
      expect(computeFrequencyBoost(count, DEFAULT_WEIGHTING_CONFIG)).toBeGreaterThanOrEqual(1.0);
    }
  });
});

// ─── Property 69: Memory Priority and Intent Resonance Boost ─────────────────

describe('Property 69: Memory Priority and Intent Resonance Boost', () => {
  it('unresolved status receives priority_boost_factor (1.4×)', () => {
    const config = DEFAULT_WEIGHTING_CONFIG;
    const boost = computePriorityBoost({ status: 'unresolved' }, config);
    expect(boost).toBe(config.priority_boost_factor);
  });

  it('active status receives priority_boost_factor (1.4×)', () => {
    const config = DEFAULT_WEIGHTING_CONFIG;
    const boost = computePriorityBoost({ status: 'active' }, config);
    expect(boost).toBe(config.priority_boost_factor);
  });

  it('completed status receives no priority boost (1.0×)', () => {
    const boost = computePriorityBoost({ status: 'completed' }, DEFAULT_WEIGHTING_CONFIG);
    expect(boost).toBe(1.0);
  });

  it('matching intent labels receive intent_resonance_boost (1.5×)', () => {
    const config = DEFAULT_WEIGHTING_CONFIG;
    const boost = computeIntentResonanceBoost(
      { intent_labels: 'project-alpha, goal-q1' },
      ['project-alpha'],
      config,
    );
    expect(boost).toBe(config.intent_resonance_boost);
  });

  it('non-matching intent labels receive no resonance boost (1.0×)', () => {
    const boost = computeIntentResonanceBoost(
      { intent_labels: 'other-project' },
      ['project-alpha'],
      DEFAULT_WEIGHTING_CONFIG,
    );
    expect(boost).toBe(1.0);
  });

  it('empty intent_node_labels list results in no resonance boost', () => {
    const boost = computeIntentResonanceBoost(
      { intent_labels: 'project-alpha' },
      [],
      DEFAULT_WEIGHTING_CONFIG,
    );
    expect(boost).toBe(1.0);
  });
});
