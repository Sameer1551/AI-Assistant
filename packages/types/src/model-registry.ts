/**
 * @module model-registry
 * @description Data models for the LLM_Gateway Model Registry — versioned catalog
 * of supported models with routing, canary deployment, and circuit breaker configuration.
 *
 * The LLM_Gateway is the sole component permitted to invoke language model providers.
 * The Model_Registry lists each supported model by provider, identifier, capability tags,
 * cost coefficients, residency constraints, and approval status.
 *
 * @see Requirement 4.2 — versioned Model_Registry
 */

/**
 * Approval status of a model in the registry.
 * Controls whether the model is eligible for routing decisions.
 */
export type ModelApprovalStatus = 'approved' | 'pending' | 'deprecated' | 'blocked';

/**
 * Cost coefficients for a model, expressed per 1,000 tokens.
 */
export interface ModelCostCoefficients {
  /** Cost per 1,000 prompt/input tokens. */
  readonly prompt_per_1k: number;

  /** Cost per 1,000 completion/output tokens. */
  readonly completion_per_1k: number;
}

/**
 * Circuit breaker configuration for a model.
 *
 * When the downstream model error rate within the configured rolling window
 * exceeds the error threshold, the LLM_Gateway opens the circuit breaker
 * for the configured cooldown duration, preventing further requests to that model.
 *
 * @see Requirement 4.10 — circuit breaker activation on error rate threshold
 */
export interface CircuitBreakerConfig {
  /**
   * Error rate percentage threshold (0-100) within the rolling window
   * that triggers the circuit breaker to open.
   */
  readonly error_threshold: number;

  /** Rolling window duration in milliseconds for error rate calculation. */
  readonly rolling_window_ms: number;

  /** Cooldown duration in milliseconds before the circuit breaker closes. */
  readonly cooldown_ms: number;
}

/**
 * Canary deployment configuration for progressive traffic shifting.
 *
 * Canary deployment routes an initial fraction of traffic to a new model version,
 * progressively increasing the fraction per schedule when health metrics remain
 * within tolerances. Auto-reverts on health metric breach.
 *
 * @see Requirement 30.1 — initial canary fraction
 * @see Requirement 30.2 — progression when healthy
 * @see Requirement 30.3 — auto-revert on breach
 */
export interface CanaryConfig {
  /**
   * Initial fraction of traffic routed to the canary version.
   * Value between 0.0 and 1.0 (e.g., 0.01 for 1%).
   */
  readonly initial_fraction: number;

  /**
   * Ordered schedule of traffic fractions for progressive rollout.
   * Each entry represents the next traffic fraction to advance to.
   * @example [0.01, 0.05, 0.25, 0.50, 1.0]
   */
  readonly progression_schedule: readonly number[];

  /**
   * Health metric tolerances that must be satisfied to progress.
   * Keys are metric names, values are maximum acceptable deviation thresholds.
   * @example { "error_rate": 0.02, "latency_p95_ms": 500 }
   */
  readonly health_tolerances: Readonly<Record<string, number>>;

  /**
   * Threshold at which the canary is automatically reverted.
   * If any health metric exceeds its tolerance by this factor,
   * traffic is immediately shifted back to the stable version.
   * Value between 0.0 and 1.0 representing the breach severity threshold.
   */
  readonly auto_revert_threshold: number;
}

/**
 * A single entry in the LLM_Gateway's versioned Model Registry.
 *
 * Each entry describes a model available for routing, including its provider,
 * capabilities, cost, residency constraints, approval status, and operational
 * configuration (circuit breaker, canary deployment).
 *
 * @see Requirement 4.2 — versioned Model_Registry with provider, identifier,
 *   capability_tags, cost_coefficients, residency_constraints, approval_status
 * @see Requirement 4.10 — circuit breaker per model
 * @see Requirement 30.1 — canary deployment configuration
 */
export interface ModelRegistryEntry {
  /** Unique identifier for this model entry. */
  readonly model_id: string;

  /** Model provider name (e.g., "openai", "anthropic", "local"). */
  readonly provider: string;

  /** Provider-specific model identifier (e.g., "gpt-4o", "claude-3-opus"). */
  readonly identifier: string;

  /**
   * Capability tags describing what the model can do.
   * Used for routing decisions based on task type.
   * @example ["reasoning", "code", "vision", "function_calling"]
   */
  readonly capability_tags: readonly string[];

  /** Cost coefficients for budget calculations. */
  readonly cost_coefficients: ModelCostCoefficients;

  /**
   * Data residency regions where this model is available.
   * Used to enforce tenant residency policy and Offline_Mode constraints.
   * @example ["us-east-1", "eu-west-1", "tenant-local"]
   */
  readonly residency_constraints: readonly string[];

  /** Current approval status controlling routing eligibility. */
  readonly approval_status: ModelApprovalStatus;

  /** Version identifier for this registry entry. */
  readonly version: string;

  /**
   * Ordered list of model_ids to try on failure/timeout/policy violation.
   * The LLM_Gateway retries against the next eligible model in this chain.
   * @see Requirement 4.5 — fallback chain retry
   */
  readonly fallback_chain: readonly string[];

  /** Circuit breaker configuration for this model. */
  readonly circuit_breaker_config: CircuitBreakerConfig;

  /** Canary deployment configuration for progressive rollout. */
  readonly canary_config: CanaryConfig;

  /** ISO 8601 timestamp when this entry was created. */
  readonly created_at: string;

  /** ISO 8601 timestamp when this entry was last updated. */
  readonly updated_at: string;
}
