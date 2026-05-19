/**
 * LLM Gateway service interfaces.
 * Service contracts and dependency injection interfaces for model registry,
 * provider abstraction, model routing, prompt-injection defense, output filtering,
 * rate limiting, budget enforcement, and circuit breaking.
 *
 * @see Requirement 4.2 — versioned Model_Registry
 * @see Requirement 4.6 — prompt-injection defense
 * @see Requirement 4.7 — output-filtering pipeline
 * @see Requirement 4.8 — budget enforcement
 * @see Requirement 4.9 — rate limiting
 * @see Requirement 4.10 — circuit breaker
 * @see Requirement 4.12 — dual-model architecture (local + cloud)
 * @see Requirement 4.13 — provider abstraction layer
 */

import type { ModelRegistryEntry } from '@may/types';

// Re-export prompt-injection defense interfaces
export type {
  IPromptInjectionDefense,
  InjectionSeverity,
  InjectionCategory,
  InjectionDetectionResult,
  SanitizationResult,
} from './prompt-injection-defense.js';

// Re-export output filter interfaces
export type {
  IOutputFilter,
  FilteredContentCategory,
  OutputRedaction,
  TenantOutputPolicy,
  DenyRule,
  OutputFilterResult,
} from './output-filter.js';

// Re-export rate limiter interfaces
export type {
  IRateLimiter,
  RateLimitResult,
  RateLimitWindowConfig,
} from './rate-limiter.js';

// Re-export budget enforcer interfaces
export type {
  IBudgetEnforcer,
  BudgetCheckResult,
  BudgetEnforcementConfig,
  UsageRecord,
} from './budget-enforcer.js';

// Re-export circuit breaker interfaces
export type {
  ICircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerCheckResult,
  CircuitBreakerInstanceConfig,
} from './circuit-breaker.js';

// Re-export model router interfaces
export type {
  IModelRouter,
  IProviderHealthProvider,
  RoutingStrategy,
  RoutingWeights,
  RoutingRequest,
  RoutingDecision,
  ScoredModel,
  FactorScores,
  DataPrivacyLevel,
} from './model-router.js';

// Re-export canary deployment interfaces
export type {
  ICanaryDeploymentService,
  CanaryDeploymentStatus,
  CanaryTargetType,
  CanaryHealthMetrics,
  CanaryMetricsComparison,
  AlertSeverity,
  CanaryAlert,
  CanaryDeployment,
  CreateCanaryDeploymentInput,
  TrafficRoutingDecision,
} from './canary-deployment.js';

// ─── Model Registry Interface ────────────────────────────────────────────────

/**
 * Query options for listing model registry entries.
 */
export interface ModelRegistryListOptions {
  /** Filter by provider name. */
  readonly provider?: string;
  /** Filter by approval status. */
  readonly approval_status?: ModelRegistryEntry['approval_status'];
  /** Filter by capability tag (entries must include this tag). */
  readonly capability_tag?: string;
  /** Filter by residency constraint (entries must include this region). */
  readonly residency_region?: string;
}

/**
 * Result of a model registry create or update operation.
 */
export interface ModelRegistryMutationResult {
  /** The created or updated entry. */
  readonly entry: ModelRegistryEntry;
  /** The previous version (undefined for create operations). */
  readonly previous_version?: string;
}

/**
 * Model Registry — versioned catalog of supported models.
 *
 * Provides CRUD operations for ModelRegistryEntry with automatic versioning.
 * Each mutation increments the entry version and updates timestamps.
 *
 * @see Requirement 4.2 — versioned Model_Registry with provider, identifier,
 *   capability_tags, cost_coefficients, residency_constraints, approval_status
 */
export interface IModelRegistry {
  /**
   * Get a model registry entry by its model_id.
   *
   * @param modelId - The unique model identifier
   * @returns The entry if found, null otherwise
   */
  get(modelId: string): Promise<ModelRegistryEntry | null>;

  /**
   * List model registry entries with optional filtering.
   *
   * @param options - Optional filter criteria
   * @returns Array of matching entries
   */
  list(options?: ModelRegistryListOptions): Promise<readonly ModelRegistryEntry[]>;

  /**
   * Create a new model registry entry.
   *
   * @param entry - The entry to create (version and timestamps will be set automatically)
   * @returns The created entry with version and timestamps populated
   * @throws If an entry with the same model_id already exists
   */
  create(entry: ModelRegistryCreateInput): Promise<ModelRegistryMutationResult>;

  /**
   * Update an existing model registry entry.
   * Increments the version and updates the updated_at timestamp.
   *
   * @param modelId - The model_id of the entry to update
   * @param updates - Partial fields to update
   * @returns The updated entry with new version
   * @throws If no entry with the given model_id exists
   */
  update(modelId: string, updates: ModelRegistryUpdateInput): Promise<ModelRegistryMutationResult>;

  /**
   * Delete a model registry entry by its model_id.
   *
   * @param modelId - The model_id of the entry to delete
   * @returns True if the entry was deleted, false if not found
   */
  delete(modelId: string): Promise<boolean>;
}

/**
 * Input for creating a new model registry entry.
 * Version and timestamps are managed by the registry.
 */
export interface ModelRegistryCreateInput {
  readonly model_id: string;
  readonly provider: string;
  readonly identifier: string;
  readonly capability_tags: readonly string[];
  readonly cost_coefficients: ModelRegistryEntry['cost_coefficients'];
  readonly residency_constraints: readonly string[];
  readonly approval_status: ModelRegistryEntry['approval_status'];
  readonly fallback_chain: readonly string[];
  readonly circuit_breaker_config: ModelRegistryEntry['circuit_breaker_config'];
  readonly canary_config: ModelRegistryEntry['canary_config'];
}

/**
 * Input for updating an existing model registry entry.
 * All fields are optional — only provided fields are updated.
 */
export interface ModelRegistryUpdateInput {
  readonly provider?: string;
  readonly identifier?: string;
  readonly capability_tags?: readonly string[];
  readonly cost_coefficients?: ModelRegistryEntry['cost_coefficients'];
  readonly residency_constraints?: readonly string[];
  readonly approval_status?: ModelRegistryEntry['approval_status'];
  readonly fallback_chain?: readonly string[];
  readonly circuit_breaker_config?: ModelRegistryEntry['circuit_breaker_config'];
  readonly canary_config?: ModelRegistryEntry['canary_config'];
}

// ─── Model Provider Interface ────────────────────────────────────────────────

/**
 * Provider type classification for dual-model architecture.
 *
 * @see Requirement 4.12 — dual-model architecture (local + cloud)
 */
export type ModelProviderType = 'local' | 'cloud';

/**
 * Request to invoke a model through the provider abstraction.
 */
export interface ModelInvocationRequest {
  /** The model identifier to invoke (provider-specific). */
  readonly model_identifier: string;
  /** The prompt/messages to send to the model. */
  readonly messages: readonly ModelMessage[];
  /** Maximum tokens to generate. */
  readonly max_tokens?: number;
  /** Temperature for sampling (0.0 - 2.0). */
  readonly temperature?: number;
  /** Optional stop sequences. */
  readonly stop_sequences?: readonly string[];
  /** Request timeout in milliseconds. */
  readonly timeout_ms?: number;
}

/**
 * A message in the model invocation request.
 */
export interface ModelMessage {
  /** Role of the message sender. */
  readonly role: 'system' | 'user' | 'assistant';
  /** Content of the message. */
  readonly content: string;
}

/**
 * Response from a model invocation.
 */
export interface ModelInvocationResponse {
  /** The generated completion text. */
  readonly content: string;
  /** Number of prompt tokens consumed. */
  readonly prompt_tokens: number;
  /** Number of completion tokens generated. */
  readonly completion_tokens: number;
  /** The model identifier that produced the response. */
  readonly model: string;
  /** Finish reason for the generation. */
  readonly finish_reason: 'stop' | 'length' | 'content_filter' | 'error';
  /** Latency in milliseconds from request to response. */
  readonly latency_ms: number;
}

/**
 * Provider health status.
 */
export interface ProviderHealthStatus {
  /** Whether the provider is currently healthy. */
  readonly healthy: boolean;
  /** Last successful health check timestamp (ISO 8601). */
  readonly last_check_at: string;
  /** Current error rate (0.0 - 1.0) in the rolling window. */
  readonly error_rate: number;
  /** Average latency in milliseconds over the rolling window. */
  readonly avg_latency_ms: number;
}

/**
 * Model Provider — abstraction layer decoupling model selection from provider APIs.
 *
 * Each provider implementation handles the specifics of communicating with
 * a particular model hosting service (OpenAI, Anthropic, local inference, etc.).
 * The LLM_Gateway interacts only with this interface, making provider changes
 * transparent to consuming services.
 *
 * @see Requirement 4.13 — provider abstraction layer decouples model selection
 *   from provider-specific API contracts
 * @see Requirement 4.12 — dual-model architecture (local + cloud)
 */
export interface IModelProvider {
  /** Unique name identifying this provider (e.g., "openai", "anthropic", "local-ollama"). */
  readonly name: string;

  /** Provider type classification for routing decisions. */
  readonly type: ModelProviderType;

  /**
   * Invoke the model with the given request.
   *
   * @param request - The invocation request
   * @returns The model's response
   * @throws PlatformError on invocation failure (timeout, rate limit, content policy, etc.)
   */
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResponse>;

  /**
   * Get the current health status of this provider.
   *
   * @returns Provider health information
   */
  getHealth(): Promise<ProviderHealthStatus>;

  /**
   * Check if this provider supports the given model identifier.
   *
   * @param modelIdentifier - The provider-specific model identifier
   * @returns True if this provider can serve the model
   */
  supportsModel(modelIdentifier: string): boolean;
}

// ─── Clock Interface ─────────────────────────────────────────────────────────

/**
 * Clock abstraction for testable time-dependent logic.
 */
export interface IClock {
  /** Returns the current time as an ISO 8601 timestamp string. */
  nowISO(): string;
}

// ─── ID Generator Interface ──────────────────────────────────────────────────

/**
 * ID generator for creating unique version identifiers.
 */
export interface IIdGenerator {
  /** Generate a new unique version string. */
  version(): string;
}
