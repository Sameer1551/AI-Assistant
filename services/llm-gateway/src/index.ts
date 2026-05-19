/**
 * @may/llm-gateway - LLM Gateway Service
 *
 * The sole component permitted to invoke language model providers.
 * Handles dual-model architecture (local + cloud), provider abstraction,
 * multi-factor routing, fallback, prompt-injection defense, output filtering,
 * rate limiting, budget enforcement, circuit breaking, and canary deployment.
 *
 * @see Requirement 4.1 — LLM_Gateway is sole model invocation broker
 * @see Requirement 4.2 — versioned Model_Registry
 * @see Requirement 4.8 — budget enforcement
 * @see Requirement 4.9 — rate limiting
 * @see Requirement 4.10 — circuit breaker
 * @see Requirement 4.12 — dual-model architecture
 * @see Requirement 4.13 — provider abstraction layer
 */

export { ModelRegistry } from './model-registry.js';
export { ModelRouter } from './model-router.js';
export { PromptInjectionDefense } from './prompt-injection-defense.js';
export { OutputFilter } from './output-filter.js';
export { RateLimiter } from './rate-limiter.js';
export { BudgetEnforcer } from './budget-enforcer.js';
export { CircuitBreaker } from './circuit-breaker.js';
export { CanaryDeploymentService } from './canary-deployment.js';
export type { ICanaryAlertListener } from './canary-deployment.js';

export type {
  IModelRegistry,
  IModelProvider,
  IModelRouter,
  IProviderHealthProvider,
  IClock,
  IIdGenerator,
  ModelProviderType,
  ModelRegistryCreateInput,
  ModelRegistryUpdateInput,
  ModelRegistryListOptions,
  ModelRegistryMutationResult,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelMessage,
  ProviderHealthStatus,
  RoutingStrategy,
  RoutingWeights,
  RoutingRequest,
  RoutingDecision,
  ScoredModel,
  FactorScores,
  DataPrivacyLevel,
  IPromptInjectionDefense,
  InjectionSeverity,
  InjectionCategory,
  InjectionDetectionResult,
  SanitizationResult,
  IOutputFilter,
  FilteredContentCategory,
  OutputRedaction,
  TenantOutputPolicy,
  DenyRule,
  OutputFilterResult,
  IRateLimiter,
  RateLimitResult,
  RateLimitWindowConfig,
  IBudgetEnforcer,
  BudgetCheckResult,
  BudgetEnforcementConfig,
  UsageRecord,
  ICircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerCheckResult,
  CircuitBreakerInstanceConfig,
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
} from './interfaces/index.js';

export type {
  VersionedEntry,
  LlmGatewayErrorCode,
} from './types/index.js';
