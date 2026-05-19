/**
 * @may/types - Shared type definitions and interfaces for the May platform
 *
 * This package contains all shared contracts, interfaces, and type definitions
 * used across services in the Enterprise AI Assistant Platform.
 */

// --- Branded types (Task 1.2) ---
export { isUnitScore, toUnitScore } from './branded.js';
export type {
  UnitScore,
  TenantId,
  PrincipalId,
  CorrelationId,
  SessionId,
  ActionId,
  IdempotencyKey,
  ChallengeId,
  ISOTimestamp,
} from './branded.js';

// --- Core shared data models (Task 1.2) ---
export type { W3CTraceContext, RequestContext } from './request-context.js';

export type {
  RiskLevel,
  ActionOutcome,
  ActionRequest,
  ActionError,
  ActionResponse,
} from './action.js';

export type {
  ChallengeInputMethod,
  ConfirmationChallenge,
  ChallengeResponse,
} from './confirmation.js';

export type {
  PlatformErrorCategory,
  ErrorSeverity,
  PlatformError,
} from './errors.js';

export type {
  PIIRedactionPosture,
  PIIRedactionPolicy,
  IdentityProviderConfig,
  ConcurrencyLimits,
  RateLimitConfig,
  InterruptBudgetConfig,
  TenantConfig,
} from './tenant.js';

// --- Memory, audit, and governance data models (Task 1.3) ---
export type { MemoryLayer, Provenance, MemoryRecord } from './memory.js';

export type { AuditSeverity, AuditEvent } from './audit.js';

export type {
  DataClassification,
  PIICategory,
  PIIAction,
  PIIDetection,
  RedactionResult,
  DSARRequestType,
  DSARStatus,
  DSARRequest,
} from './governance.js';

export type {
  ResourceType,
  UsageEvent,
  HardLimitAction,
  BudgetConfig,
} from './cost.js';

// --- Cognitive intelligence and advanced memory data models (Task 1.4) ---
export type { ContextField, ContextPacket } from './context-intelligence.js';

export type {
  CognitiveDirective,
  CognitiveResponseStyle,
  CognitiveState,
  CognitiveTone,
} from './cognitive-state.js';

export type {
  CoreCharacterDefinition,
  DriftBenchmarkResult,
  Energy,
  Formality,
  FormatPreference,
  StyleProfile,
  StyleProfileName,
  StyleTone,
  Verbosity,
} from './personality.js';

export type {
  DeliveryDecision,
  InterruptBudgetStatus,
  ProactiveSignal,
} from './proactive.js';

export type {
  IntentEdge,
  IntentEdgeRelation,
  IntentNode,
  IntentNodeStatus,
  IntentNodeType,
} from './intent-graph.js';

export type {
  FreshnessClassification,
  FreshnessTier,
  GroundedClaim,
  GroundedClaimSource,
  GroundedContext,
} from './knowledge-grounding.js';

// --- Planning, simulation, goal, and extensibility data models (Task 1.5) ---
export type {
  RollbackCost,
  SimulationRecommendation,
  SimulationResult,
  FailureMode,
  ResourceDelta,
} from './simulation.js';

export type {
  GoalStatus,
  MilestoneStatus,
  Goal,
  Milestone,
  WeeklyReviewReport,
  GoalSummary,
  NextActionSuggestion,
} from './goal.js';

export type {
  UserSignal,
  ReflectionRecord,
  FailurePattern,
} from './reflection.js';

export type {
  PlanLevel,
  PlanNodeStatus,
  PlanTree,
  PlanNode,
  PlanChecklist,
  ChecklistItem,
} from './planning.js';

export type {
  PluginPermission,
  PluginManifest,
  PluginExecutionResult,
  PluginResourceUsage,
} from './plugin.js';

export type {
  ImprovementPhase,
  ImprovementDecision,
  ImprovementCycle,
  PromptVersion,
  LoRAAdapter,
} from './self-improvement.js';

export type {
  ThrottleLevel,
  ResourceStatus,
  ThrottleLevelTransition,
  ThrottleConfig,
  ThrottleThresholds,
} from './resource-governor.js';

export type {
  HardwareTier,
  PhysicalEnvironment,
  EnvironmentState,
  EnvironmentChangeEvent,
} from './environment.js';

export type {
  InferencePriority,
  InferenceTicketStatus,
  ResourceInventory,
  GPUDevice,
  LoadedModel,
  InferenceTicket,
} from './compute-fabric.js';

export type {
  Reversibility,
  ChangeType,
  RollbackDescriptor,
  RollbackStep,
  RollbackActionReference,
  DryRunResult,
  PredictedEffect,
} from './rollback.js';

// --- Workflow and model registry data models (Task 1.6) ---
export type {
  WorkflowStepStatus,
  WorkflowStatus,
  RetryPolicy,
  ResourceBudget,
  WorkflowStep,
  WorkflowDefinition,
} from './workflow.js';

export type { EmotionTrend, EmotionalState } from './emotion.js';

export type {
  ModelApprovalStatus,
  ModelCostCoefficients,
  CircuitBreakerConfig,
  CanaryConfig,
  ModelRegistryEntry,
} from './model-registry.js';
