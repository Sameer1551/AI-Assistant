/**
 * Property-based tests for model routing.
 *
 * **Validates: Requirements 4.3, 4.5**
 *
 * Property 16: Model Selection Policy Compliance — selected model satisfies all
 * tenant constraints (budget, residency, privacy, task type, complexity)
 *
 * Property 17: Model Fallback Chain — on failure/timeout/policy violation, retry
 * next eligible model up to max retries; all fallback models also satisfy hard constraints
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import { ModelRouter } from '../../src/model-router.js';
import { ModelRegistry } from '../../src/model-registry.js';
import type {
  IClock,
  IIdGenerator,
  ModelRegistryCreateInput,
  ProviderHealthStatus,
} from '../../src/interfaces/index.js';
import type {
  IProviderHealthProvider,
  RoutingRequest,
  RoutingStrategy,
  DataPrivacyLevel,
} from '../../src/interfaces/model-router.js';
import type { ModelRegistryEntry } from '@may/types';

// ─── Stub Implementations ────────────────────────────────────────────────────

class StubClock implements IClock {
  nowISO(): string {
    return '2024-01-01T00:00:00.000Z';
  }
}

class StubIdGenerator implements IIdGenerator {
  private counter = 0;
  version(): string {
    this.counter++;
    return `v${this.counter}`;
  }
}

class StubHealthProvider implements IProviderHealthProvider {
  private healthMap = new Map<string, ProviderHealthStatus>();

  setHealth(provider: string, status: ProviderHealthStatus): void {
    this.healthMap.set(provider, status);
  }

  async getHealth(providerName: string): Promise<ProviderHealthStatus | null> {
    return this.healthMap.get(providerName) ?? null;
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for routing strategies. */
const strategyArb: fc.Arbitrary<RoutingStrategy> = fc.constantFrom(
  'cost_optimized',
  'quality_optimized',
  'latency_optimized',
  'balanced',
);

/** Arbitrary for data privacy levels. */
const privacyLevelArb: fc.Arbitrary<DataPrivacyLevel> = fc.constantFrom(
  'public',
  'internal',
  'confidential',
  'restricted',
);

/** Arbitrary for non-restricted privacy levels (models in any region can serve these). */
const nonRestrictedPrivacyArb: fc.Arbitrary<DataPrivacyLevel> = fc.constantFrom(
  'public',
  'internal',
  'confidential',
);

/** Arbitrary for residency regions. */
const residencyRegionArb = fc.constantFrom('us-east-1', 'eu-west-1', 'tenant-local');

/** Arbitrary for capability tags (subset of known tags). */
const capabilityTagArb = fc.constantFrom(
  'reasoning',
  'code',
  'vision',
  'function_calling',
  'embeddings',
);

/** Arbitrary for a set of required capabilities (0-2 tags from the known set). */
const requiredCapabilitiesArb = fc
  .subarray(['reasoning', 'code'] as string[], { minLength: 0, maxLength: 2 })
  .map((arr) => [...new Set(arr)]);

/** Arbitrary for task complexity in [0.0, 1.0]. */
const taskComplexityArb = fc.double({ min: 0, max: 1, noNaN: true });

/** Arbitrary for budget remaining (positive values that allow at least some models). */
const budgetRemainingArb = fc.double({ min: 0.01, max: 10000, noNaN: true });

/** Arbitrary for max latency in ms. */
const maxLatencyArb = fc.integer({ min: 500, max: 30000 });

/** Arbitrary for max retries. */
const maxRetriesArb = fc.integer({ min: 0, max: 5 });

// ─── Test Setup ──────────────────────────────────────────────────────────────

/**
 * Creates a diverse model registry with models spanning different providers,
 * capabilities, residency constraints, and cost levels.
 */
async function setupRegistry(): Promise<{
  registry: ModelRegistry;
  healthProvider: StubHealthProvider;
  router: ModelRouter;
}> {
  const clock = new StubClock();
  const idGen = new StubIdGenerator();
  const registry = new ModelRegistry(clock, idGen);
  const healthProvider = new StubHealthProvider();

  // Cloud model: OpenAI GPT-4o — expensive, many capabilities, us-east-1 + eu-west-1
  await registry.create({
    model_id: 'gpt-4o',
    provider: 'openai',
    identifier: 'gpt-4o',
    capability_tags: ['reasoning', 'code', 'vision', 'function_calling'],
    cost_coefficients: { prompt_per_1k: 0.03, completion_per_1k: 0.06 },
    residency_constraints: ['us-east-1', 'eu-west-1'],
    approval_status: 'approved',
    fallback_chain: [],
    circuit_breaker_config: { error_threshold: 50, rolling_window_ms: 60000, cooldown_ms: 30000 },
    canary_config: {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 500 },
      auto_revert_threshold: 0.5,
    },
  });

  // Cloud model: Anthropic Claude — moderate cost, us-east-1 only
  await registry.create({
    model_id: 'claude-3-opus',
    provider: 'anthropic',
    identifier: 'claude-3-opus',
    capability_tags: ['reasoning', 'code', 'vision'],
    cost_coefficients: { prompt_per_1k: 0.015, completion_per_1k: 0.075 },
    residency_constraints: ['us-east-1'],
    approval_status: 'approved',
    fallback_chain: [],
    circuit_breaker_config: { error_threshold: 50, rolling_window_ms: 60000, cooldown_ms: 30000 },
    canary_config: {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 500 },
      auto_revert_threshold: 0.5,
    },
  });

  // Cloud model: GPT-4o-mini — cheap, fewer capabilities, us-east-1 + eu-west-1
  await registry.create({
    model_id: 'gpt-4o-mini',
    provider: 'openai',
    identifier: 'gpt-4o-mini',
    capability_tags: ['reasoning', 'code'],
    cost_coefficients: { prompt_per_1k: 0.00015, completion_per_1k: 0.0006 },
    residency_constraints: ['us-east-1', 'eu-west-1'],
    approval_status: 'approved',
    fallback_chain: [],
    circuit_breaker_config: { error_threshold: 50, rolling_window_ms: 60000, cooldown_ms: 30000 },
    canary_config: {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 500 },
      auto_revert_threshold: 0.5,
    },
  });

  // Local model: Llama-3 — free, tenant-local only
  await registry.create({
    model_id: 'llama-3-local',
    provider: 'local-ollama',
    identifier: 'llama-3-8b',
    capability_tags: ['reasoning', 'code'],
    cost_coefficients: { prompt_per_1k: 0, completion_per_1k: 0 },
    residency_constraints: ['tenant-local'],
    approval_status: 'approved',
    fallback_chain: [],
    circuit_breaker_config: { error_threshold: 50, rolling_window_ms: 60000, cooldown_ms: 30000 },
    canary_config: {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 500 },
      auto_revert_threshold: 0.5,
    },
  });

  // Local model: Mistral — free, tenant-local, vision capability
  await registry.create({
    model_id: 'mistral-local',
    provider: 'local-ollama',
    identifier: 'mistral-7b',
    capability_tags: ['reasoning', 'code', 'vision'],
    cost_coefficients: { prompt_per_1k: 0, completion_per_1k: 0 },
    residency_constraints: ['tenant-local'],
    approval_status: 'approved',
    fallback_chain: [],
    circuit_breaker_config: { error_threshold: 50, rolling_window_ms: 60000, cooldown_ms: 30000 },
    canary_config: {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 500 },
      auto_revert_threshold: 0.5,
    },
  });

  // Set all providers as healthy
  healthProvider.setHealth('openai', {
    healthy: true,
    last_check_at: '2024-01-01T00:00:00.000Z',
    error_rate: 0.01,
    avg_latency_ms: 800,
  });
  healthProvider.setHealth('anthropic', {
    healthy: true,
    last_check_at: '2024-01-01T00:00:00.000Z',
    error_rate: 0.02,
    avg_latency_ms: 1200,
  });
  healthProvider.setHealth('local-ollama', {
    healthy: true,
    last_check_at: '2024-01-01T00:00:00.000Z',
    error_rate: 0.0,
    avg_latency_ms: 200,
  });

  const router = new ModelRouter(registry, healthProvider);
  return { registry, healthProvider, router };
}

/**
 * Checks whether a model satisfies the residency constraint for a given request.
 */
function satisfiesResidency(model: ModelRegistryEntry, request: RoutingRequest): boolean {
  if (request.offline_mode) {
    return model.residency_constraints.includes('tenant-local');
  }
  return (
    model.residency_constraints.includes(request.residency_region) ||
    model.residency_constraints.includes('tenant-local')
  );
}

/**
 * Checks whether a model satisfies the privacy constraint.
 * Restricted data requires tenant-local models.
 */
function satisfiesPrivacy(model: ModelRegistryEntry, request: RoutingRequest): boolean {
  if (request.privacy_level === 'restricted') {
    return model.residency_constraints.includes('tenant-local');
  }
  return true;
}

/**
 * Checks whether a model satisfies the capability constraint.
 */
function satisfiesCapabilities(model: ModelRegistryEntry, request: RoutingRequest): boolean {
  return request.required_capabilities.every((tag) =>
    model.capability_tags.includes(tag),
  );
}

/**
 * Checks whether a model satisfies the budget constraint.
 */
function satisfiesBudget(model: ModelRegistryEntry, request: RoutingRequest): boolean {
  const estimatedMinCost =
    model.cost_coefficients.prompt_per_1k + model.cost_coefficients.completion_per_1k;
  if (estimatedMinCost > request.budget_remaining && estimatedMinCost > 0) {
    return false;
  }
  return true;
}

/**
 * Checks whether a model satisfies ALL hard constraints for a routing request.
 */
function satisfiesAllConstraints(model: ModelRegistryEntry, request: RoutingRequest): boolean {
  return (
    satisfiesResidency(model, request) &&
    satisfiesPrivacy(model, request) &&
    satisfiesCapabilities(model, request) &&
    satisfiesBudget(model, request)
  );
}

// ─── Property 16: Model Selection Policy Compliance ──────────────────────────

describe('Property 16: Model Selection Policy Compliance', () => {
  /**
   * **Validates: Requirements 4.3**
   *
   * For any valid routing request to the LLM_Gateway, the selected model SHALL
   * satisfy ALL of: the tenant's budget mode, residency policy, privacy level,
   * task type compatibility (capabilities), and complexity score constraints.
   */

  it('selected model satisfies residency constraint for any strategy and region', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        fc.constantFrom('us-east-1', 'eu-west-1', 'tenant-local'),
        taskComplexityArb,
        async (strategy, region, complexity) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: region,
            offline_mode: false,
            strategy,
            max_retries: 2,
          };

          const decision = await router.route(request);
          expect(satisfiesResidency(decision.selected_model, request)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selected model satisfies offline mode constraint (tenant-local only)', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        taskComplexityArb,
        maxRetriesArb,
        async (strategy, complexity, maxRetries) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: true,
            strategy,
            max_retries: maxRetries,
          };

          const decision = await router.route(request);
          expect(decision.selected_model.residency_constraints).toContain('tenant-local');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selected model satisfies capability requirements for any combination of required tags', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        requiredCapabilitiesArb,
        taskComplexityArb,
        async (strategy, capabilities, complexity) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: capabilities,
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: 2,
          };

          const decision = await router.route(request);
          for (const tag of capabilities) {
            expect(decision.selected_model.capability_tags).toContain(tag);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selected model satisfies privacy constraint (restricted requires tenant-local)', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        privacyLevelArb,
        taskComplexityArb,
        async (strategy, privacy, complexity) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: privacy,
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: 2,
          };

          const decision = await router.route(request);
          expect(satisfiesPrivacy(decision.selected_model, request)).toBe(true);

          // Specifically: if privacy is restricted, model must be tenant-local
          if (privacy === 'restricted') {
            expect(decision.selected_model.residency_constraints).toContain('tenant-local');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selected model satisfies budget constraint for any budget level', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        budgetRemainingArb,
        taskComplexityArb,
        async (strategy, budget, complexity) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: budget,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: 2,
          };

          const decision = await router.route(request);
          expect(satisfiesBudget(decision.selected_model, request)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selected model satisfies ALL hard constraints simultaneously for any valid request', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        nonRestrictedPrivacyArb,
        taskComplexityArb,
        budgetRemainingArb,
        maxLatencyArb,
        fc.boolean(),
        async (strategy, privacy, complexity, budget, maxLatency, offlineMode) => {
          // When offline, use tenant-local region; otherwise use a cloud region
          const region = offlineMode ? 'tenant-local' : 'us-east-1';

          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: privacy,
            max_latency_ms: maxLatency,
            budget_remaining: budget,
            residency_region: region,
            offline_mode: offlineMode,
            strategy,
            max_retries: 2,
          };

          const decision = await router.route(request);

          // The selected model must satisfy ALL constraints
          expect(satisfiesAllConstraints(decision.selected_model, request)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── Property 17: Model Fallback Chain ───────────────────────────────────────

describe('Property 17: Model Fallback Chain', () => {
  /**
   * **Validates: Requirements 4.5**
   *
   * For any routing request with multiple eligible models, the fallback chain
   * must contain alternative models that also satisfy all hard constraints,
   * and the chain length must not exceed max_retries.
   */

  it('all models in fallback chain satisfy the same hard constraints as the selected model', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        nonRestrictedPrivacyArb,
        taskComplexityArb,
        budgetRemainingArb,
        maxRetriesArb,
        fc.boolean(),
        async (strategy, privacy, complexity, budget, maxRetries, offlineMode) => {
          const region = offlineMode ? 'tenant-local' : 'us-east-1';

          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: privacy,
            max_latency_ms: 10000,
            budget_remaining: budget,
            residency_region: region,
            offline_mode: offlineMode,
            strategy,
            max_retries: maxRetries,
          };

          const decision = await router.route(request);

          // Every model in the fallback chain must satisfy all hard constraints
          for (const fallbackModel of decision.fallback_chain) {
            expect(satisfiesAllConstraints(fallbackModel, request)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('fallback chain length never exceeds max_retries', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        maxRetriesArb,
        taskComplexityArb,
        async (strategy, maxRetries, complexity) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: maxRetries,
          };

          const decision = await router.route(request);
          expect(decision.fallback_chain.length).toBeLessThanOrEqual(maxRetries);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('fallback chain does not contain the selected model', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        taskComplexityArb,
        maxRetriesArb,
        async (strategy, complexity, maxRetries) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: maxRetries,
          };

          const decision = await router.route(request);
          const fallbackIds = decision.fallback_chain.map((m) => m.model_id);
          expect(fallbackIds).not.toContain(decision.selected_model.model_id);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('fallback chain contains unique models (no duplicates)', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        taskComplexityArb,
        maxRetriesArb,
        async (strategy, complexity, maxRetries) => {
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: maxRetries,
          };

          const decision = await router.route(request);
          const fallbackIds = decision.fallback_chain.map((m) => m.model_id);
          const uniqueIds = new Set(fallbackIds);
          expect(uniqueIds.size).toBe(fallbackIds.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('when multiple eligible models exist, fallback chain is non-empty (max_retries > 0)', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        taskComplexityArb,
        async (strategy, complexity) => {
          // Use a request that should match multiple models (us-east-1, reasoning, high budget)
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning'],
            privacy_level: 'internal',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: 3,
          };

          const decision = await router.route(request);

          // With our registry setup, multiple models match these constraints
          // so the fallback chain should be non-empty
          expect(decision.fallback_chain.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('with only one eligible model, fallback chain is empty', async () => {
    const { router } = await setupRegistry();

    await fc.assert(
      fc.asyncProperty(
        strategyArb,
        taskComplexityArb,
        maxRetriesArb,
        async (strategy, complexity, maxRetries) => {
          // Restricted privacy + vision capability = only mistral-local qualifies
          const request: RoutingRequest = {
            task_complexity: complexity,
            required_capabilities: ['reasoning', 'vision'],
            privacy_level: 'restricted',
            max_latency_ms: 10000,
            budget_remaining: 1000,
            residency_region: 'us-east-1',
            offline_mode: false,
            strategy,
            max_retries: maxRetries,
          };

          const decision = await router.route(request);
          // Only mistral-local has vision + tenant-local
          expect(decision.selected_model.model_id).toBe('mistral-local');
          expect(decision.fallback_chain).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
