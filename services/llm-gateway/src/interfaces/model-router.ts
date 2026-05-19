/**
 * Model Router interfaces — multi-factor routing engine contracts.
 *
 * Defines the routing request/response types, routing policies, and the
 * IModelRouter interface for selecting the optimal model based on multiple
 * factors: task complexity, cost constraints, latency requirements, model
 * capabilities, and current provider health.
 *
 * @see Requirement 4.3 — model selection consistent with tenant policy
 * @see Requirement 4.4 — Offline_Mode residency enforcement
 * @see Requirement 4.14 — multi-factor routing criteria
 * @see Requirement 4.15 — provider health monitoring and exclusion
 */

import type { ModelRegistryEntry } from '@may/types';
import type { ProviderHealthStatus } from './index.js';

// ─── Routing Policy / Strategy ───────────────────────────────────────────────

/**
 * Routing strategy that determines how factors are weighted.
 *
 * - cost_optimized: Prioritizes lowest cost models
 * - quality_optimized: Prioritizes highest capability/quality models
 * - latency_optimized: Prioritizes lowest latency models
 * - balanced: Equal weighting across all factors
 */
export type RoutingStrategy =
  | 'cost_optimized'
  | 'quality_optimized'
  | 'latency_optimized'
  | 'balanced';

/**
 * Factor weights used by the scoring algorithm.
 * Each weight is in [0.0, 1.0] and they are normalized during scoring.
 */
export interface RoutingWeights {
  /** Weight for cost factor. */
  readonly cost: number;
  /** Weight for capability/quality factor. */
  readonly capability: number;
  /** Weight for latency factor. */
  readonly latency: number;
  /** Weight for provider health factor. */
  readonly health: number;
  /** Weight for load/availability factor. */
  readonly load: number;
}

// ─── Routing Request ─────────────────────────────────────────────────────────

/**
 * Privacy classification of the data being processed.
 */
export type DataPrivacyLevel = 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * A routing request containing all factors needed for model selection.
 *
 * @see Requirement 4.14 — routing criteria: task complexity, budget remaining,
 *   privacy classification, latency requirement, provider health
 */
export interface RoutingRequest {
  /** Task complexity score in [0.0, 1.0] where 1.0 is most complex. */
  readonly task_complexity: number;

  /** Required capability tags the model must support. */
  readonly required_capabilities: readonly string[];

  /** Data privacy classification for this request. */
  readonly privacy_level: DataPrivacyLevel;

  /** Maximum acceptable latency in milliseconds. */
  readonly max_latency_ms: number;

  /** Tenant's remaining budget in cost units. */
  readonly budget_remaining: number;

  /** Tenant's configured residency region. */
  readonly residency_region: string;

  /** Whether the tenant has Offline_Mode enabled. */
  readonly offline_mode: boolean;

  /** Routing strategy/policy to apply. */
  readonly strategy: RoutingStrategy;

  /** Maximum number of retries allowed for fallback. */
  readonly max_retries: number;

  /** Optional: specific model IDs to exclude from selection. */
  readonly excluded_model_ids?: readonly string[];
}

// ─── Routing Decision ────────────────────────────────────────────────────────

/**
 * A scored model candidate produced by the routing engine.
 */
export interface ScoredModel {
  /** The model registry entry. */
  readonly model: ModelRegistryEntry;
  /** Overall composite score in [0.0, 1.0]. */
  readonly score: number;
  /** Individual factor scores for observability. */
  readonly factor_scores: FactorScores;
}

/**
 * Individual factor scores for a model candidate.
 */
export interface FactorScores {
  /** Cost score — higher means cheaper. */
  readonly cost: number;
  /** Capability score — higher means better match. */
  readonly capability: number;
  /** Latency score — higher means faster. */
  readonly latency: number;
  /** Health score — higher means healthier provider. */
  readonly health: number;
  /** Load score — higher means less loaded. */
  readonly load: number;
}

/**
 * The routing decision produced by the model router.
 */
export interface RoutingDecision {
  /** The selected primary model. */
  readonly selected_model: ModelRegistryEntry;
  /** The composite score of the selected model. */
  readonly selected_score: number;
  /** Ordered fallback chain of eligible models (excluding selected). */
  readonly fallback_chain: readonly ModelRegistryEntry[];
  /** The strategy that was applied. */
  readonly strategy: RoutingStrategy;
  /** All scored candidates for observability (sorted by score descending). */
  readonly scored_candidates: readonly ScoredModel[];
  /** Reason if no model could be selected. */
  readonly rejection_reason?: string;
}

// ─── Provider Health Provider ────────────────────────────────────────────────

/**
 * Interface for retrieving provider health status.
 * Used by the router to factor in current provider health.
 */
export interface IProviderHealthProvider {
  /**
   * Get the health status for a given provider.
   * @param providerName - The provider name (e.g., "openai", "anthropic")
   * @returns Health status, or null if unknown
   */
  getHealth(providerName: string): Promise<ProviderHealthStatus | null>;
}

// ─── Model Router Interface ──────────────────────────────────────────────────

/**
 * Model Router — multi-factor routing engine for selecting the optimal model.
 *
 * Evaluates available models from the registry against multiple factors
 * (task complexity, cost, latency, capabilities, provider health) and
 * selects the best model according to the configured routing strategy.
 *
 * @see Requirement 4.3 — model selection consistent with tenant policy
 * @see Requirement 4.4 — Offline_Mode residency enforcement
 * @see Requirement 4.14 — multi-factor routing criteria
 * @see Requirement 4.15 — provider health exclusion
 */
export interface IModelRouter {
  /**
   * Route a request to the optimal model.
   *
   * @param request - The routing request with all factor inputs
   * @returns A routing decision with selected model and fallback chain
   * @throws If no eligible model can be found
   */
  route(request: RoutingRequest): Promise<RoutingDecision>;

  /**
   * Get the weight configuration for a given strategy.
   *
   * @param strategy - The routing strategy
   * @returns The factor weights for that strategy
   */
  getWeights(strategy: RoutingStrategy): RoutingWeights;
}
