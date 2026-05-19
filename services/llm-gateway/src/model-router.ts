/**
 * Multi-factor Model Router implementation.
 *
 * Selects the optimal model from the registry based on multiple factors:
 * - Task complexity score
 * - Cost constraints (budget remaining)
 * - Latency requirements
 * - Model capabilities (required tags)
 * - Provider health status
 *
 * Supports routing strategies: cost_optimized, quality_optimized,
 * latency_optimized, and balanced.
 *
 * Enforces tenant constraints:
 * - Budget mode / remaining budget
 * - Residency policy
 * - Offline_Mode (only tenant-local models)
 * - Privacy classification
 *
 * Provides fallback logic when preferred model is unavailable.
 *
 * @see Requirement 4.3 — model selection consistent with tenant policy
 * @see Requirement 4.4 — Offline_Mode residency enforcement
 * @see Requirement 4.14 — multi-factor routing criteria
 * @see Requirement 4.15 — provider health monitoring and exclusion
 */

import type { ModelRegistryEntry } from '@may/types';
import type {
  IModelRegistry,
} from './interfaces/index.js';
import type {
  IModelRouter,
  IProviderHealthProvider,
  RoutingRequest,
  RoutingDecision,
  RoutingStrategy,
  RoutingWeights,
  ScoredModel,
  FactorScores,
} from './interfaces/model-router.js';

/**
 * Default weight configurations for each routing strategy.
 */
const STRATEGY_WEIGHTS: Record<RoutingStrategy, RoutingWeights> = {
  cost_optimized: {
    cost: 0.5,
    capability: 0.2,
    latency: 0.1,
    health: 0.15,
    load: 0.05,
  },
  quality_optimized: {
    cost: 0.05,
    capability: 0.5,
    latency: 0.15,
    health: 0.2,
    load: 0.1,
  },
  latency_optimized: {
    cost: 0.1,
    capability: 0.15,
    latency: 0.5,
    health: 0.2,
    load: 0.05,
  },
  balanced: {
    cost: 0.25,
    capability: 0.25,
    latency: 0.2,
    health: 0.2,
    load: 0.1,
  },
};

/**
 * Complexity thresholds for model capability matching.
 * Higher complexity tasks require models with more capability tags.
 */
const COMPLEXITY_CAPABILITY_THRESHOLD = 0.7;

/**
 * Privacy level ordering for constraint checking.
 * Models serving restricted data must support tenant-local residency.
 */
const PRIVACY_REQUIRES_LOCAL: ReadonlySet<string> = new Set(['restricted']);

/**
 * The local residency region identifier used for Offline_Mode.
 */
const TENANT_LOCAL_REGION = 'tenant-local';

/**
 * Multi-factor model routing engine.
 *
 * Integrates with the model registry to get available models and their
 * capabilities, and with provider health to exclude unhealthy providers.
 */
export class ModelRouter implements IModelRouter {
  constructor(
    private readonly registry: IModelRegistry,
    private readonly healthProvider: IProviderHealthProvider,
  ) {}

  async route(request: RoutingRequest): Promise<RoutingDecision> {
    // 1. Get all approved models from registry
    const allModels = await this.registry.list({ approval_status: 'approved' });

    // 2. Filter to eligible models based on hard constraints
    const eligible = await this.filterEligible(allModels, request);

    // 3. If no eligible models, return decision with rejection reason
    if (eligible.length === 0) {
      throw new Error(
        'No eligible model found: all models were excluded by routing constraints ' +
        `(residency=${request.residency_region}, offline=${request.offline_mode}, ` +
        `capabilities=${request.required_capabilities.join(',')}, ` +
        `privacy=${request.privacy_level})`,
      );
    }

    // 4. Score each eligible model
    const weights = this.getWeights(request.strategy);
    const scored = await this.scoreModels(eligible, request, weights);

    // 5. Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // 6. Select primary model and build fallback chain
    if (scored.length === 0) {
      throw new Error(
        'No eligible model found: scoring produced no candidates',
      );
    }

    const selected = scored[0]!;
    const fallbackCandidates = scored.slice(1, request.max_retries + 1);

    return {
      selected_model: selected.model,
      selected_score: selected.score,
      fallback_chain: fallbackCandidates.map((s) => s.model),
      strategy: request.strategy,
      scored_candidates: scored,
    };
  }

  getWeights(strategy: RoutingStrategy): RoutingWeights {
    return STRATEGY_WEIGHTS[strategy];
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Filter models to only those meeting hard constraints.
   * Hard constraints are pass/fail — a model either meets them or is excluded.
   */
  private async filterEligible(
    models: readonly ModelRegistryEntry[],
    request: RoutingRequest,
  ): Promise<ModelRegistryEntry[]> {
    const eligible: ModelRegistryEntry[] = [];

    for (const model of models) {
      // Skip explicitly excluded models
      if (request.excluded_model_ids?.includes(model.model_id)) {
        continue;
      }

      // Offline_Mode: only allow models with tenant-local residency
      if (request.offline_mode) {
        if (!model.residency_constraints.includes(TENANT_LOCAL_REGION)) {
          continue;
        }
      }

      // Residency constraint: model must be available in tenant's region
      // (or tenant-local for offline mode, already handled above)
      if (!request.offline_mode) {
        if (
          !model.residency_constraints.includes(request.residency_region) &&
          !model.residency_constraints.includes(TENANT_LOCAL_REGION)
        ) {
          continue;
        }
      }

      // Privacy constraint: restricted data requires tenant-local models
      if (PRIVACY_REQUIRES_LOCAL.has(request.privacy_level)) {
        if (!model.residency_constraints.includes(TENANT_LOCAL_REGION)) {
          continue;
        }
      }

      // Capability constraint: model must have all required capability tags
      if (request.required_capabilities.length > 0) {
        const hasAll = request.required_capabilities.every((tag) =>
          model.capability_tags.includes(tag),
        );
        if (!hasAll) {
          continue;
        }
      }

      // Budget constraint: estimated cost must not exceed remaining budget
      // Use a simple heuristic: if the model's cost per 1k tokens exceeds
      // the remaining budget, exclude it (assumes at least 1k tokens needed)
      const estimatedMinCost = model.cost_coefficients.prompt_per_1k + model.cost_coefficients.completion_per_1k;
      if (estimatedMinCost > request.budget_remaining && estimatedMinCost > 0) {
        continue;
      }

      // Provider health: exclude unhealthy providers
      const health = await this.healthProvider.getHealth(model.provider);
      if (health !== null && !health.healthy) {
        continue;
      }

      eligible.push(model);
    }

    return eligible;
  }

  /**
   * Score each eligible model based on the routing factors and weights.
   */
  private async scoreModels(
    models: ModelRegistryEntry[],
    request: RoutingRequest,
    weights: RoutingWeights,
  ): Promise<ScoredModel[]> {
    const scored: ScoredModel[] = [];

    // Compute normalization bounds for cost and latency scoring
    const maxCost = Math.max(
      ...models.map((m) => m.cost_coefficients.prompt_per_1k + m.cost_coefficients.completion_per_1k),
      0.001, // avoid division by zero
    );

    for (const model of models) {
      const factorScores = await this.computeFactorScores(model, request, maxCost);
      const score = this.computeCompositeScore(factorScores, weights);
      scored.push({ model, score, factor_scores: factorScores });
    }

    return scored;
  }

  /**
   * Compute individual factor scores for a model.
   * Each score is in [0.0, 1.0] where higher is better.
   */
  private async computeFactorScores(
    model: ModelRegistryEntry,
    request: RoutingRequest,
    maxCost: number,
  ): Promise<FactorScores> {
    // Cost score: cheaper models score higher
    const totalCost = model.cost_coefficients.prompt_per_1k + model.cost_coefficients.completion_per_1k;
    const costScore = maxCost > 0 ? 1.0 - (totalCost / maxCost) : 1.0;

    // Capability score: based on how well the model matches required capabilities
    // and how many additional capabilities it has for complex tasks
    const capabilityScore = this.computeCapabilityScore(model, request);

    // Latency score: based on provider health avg_latency vs max_latency requirement
    const latencyScore = await this.computeLatencyScore(model, request);

    // Health score: based on provider error rate and availability
    const healthScore = await this.computeHealthScore(model);

    // Load score: inverse of error rate as a proxy for current load
    // (lower error rate suggests less overloaded)
    const loadScore = await this.computeLoadScore(model);

    return {
      cost: clamp(costScore, 0, 1),
      capability: clamp(capabilityScore, 0, 1),
      latency: clamp(latencyScore, 0, 1),
      health: clamp(healthScore, 0, 1),
      load: clamp(loadScore, 0, 1),
    };
  }

  /**
   * Compute capability score based on tag matching and task complexity.
   */
  private computeCapabilityScore(
    model: ModelRegistryEntry,
    request: RoutingRequest,
  ): number {
    // Base score: all required capabilities are met (already filtered)
    let score = 0.5;

    // Bonus for additional capabilities beyond required (useful for complex tasks)
    const extraCapabilities = model.capability_tags.length - request.required_capabilities.length;
    if (request.task_complexity >= COMPLEXITY_CAPABILITY_THRESHOLD) {
      // For complex tasks, more capabilities = higher score
      score += Math.min(extraCapabilities * 0.1, 0.4);
    } else {
      // For simple tasks, fewer capabilities is fine (simpler model may be faster)
      score += Math.min(extraCapabilities * 0.05, 0.2);
    }

    // Bonus for high complexity tasks with many capability tags
    if (request.task_complexity >= 0.9 && model.capability_tags.length >= 4) {
      score += 0.1;
    }

    return score;
  }

  /**
   * Compute latency score based on provider's average latency vs requirement.
   */
  private async computeLatencyScore(
    model: ModelRegistryEntry,
    request: RoutingRequest,
  ): Promise<number> {
    const health = await this.healthProvider.getHealth(model.provider);
    if (health === null) {
      // Unknown health — assume moderate latency
      return 0.5;
    }

    // Score based on how much headroom there is vs max_latency
    if (health.avg_latency_ms <= 0) {
      return 1.0;
    }

    const ratio = health.avg_latency_ms / request.max_latency_ms;
    if (ratio >= 1.0) {
      // Average latency already exceeds requirement — low score but not excluded
      // (it might still be the best option)
      return 0.1;
    }

    // Linear score: more headroom = higher score
    return 1.0 - ratio;
  }

  /**
   * Compute health score based on provider error rate.
   */
  private async computeHealthScore(model: ModelRegistryEntry): Promise<number> {
    const health = await this.healthProvider.getHealth(model.provider);
    if (health === null) {
      // Unknown health — assume moderate
      return 0.5;
    }

    // Healthy provider with low error rate scores high
    return health.healthy ? 1.0 - health.error_rate : 0.1;
  }

  /**
   * Compute load score as inverse of error rate (proxy for load).
   */
  private async computeLoadScore(model: ModelRegistryEntry): Promise<number> {
    const health = await this.healthProvider.getHealth(model.provider);
    if (health === null) {
      return 0.5;
    }

    // Lower error rate = less loaded = higher score
    return 1.0 - health.error_rate;
  }

  /**
   * Compute the weighted composite score from individual factor scores.
   */
  private computeCompositeScore(factors: FactorScores, weights: RoutingWeights): number {
    const totalWeight = weights.cost + weights.capability + weights.latency + weights.health + weights.load;
    if (totalWeight === 0) {
      return 0;
    }

    const weighted =
      factors.cost * weights.cost +
      factors.capability * weights.capability +
      factors.latency * weights.latency +
      factors.health * weights.health +
      factors.load * weights.load;

    return weighted / totalWeight;
  }
}

/**
 * Clamp a value between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
