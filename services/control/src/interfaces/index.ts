/**
 * Control service interfaces — barrel export.
 * Re-exports all interface modules for the control service.
 */

// Common interfaces (clock, id generator)
export type { IClock, IIdGenerator } from './common.js';

// Action executor interfaces (risk-level confirmation, authorization)
export type {
  ActionState,
  AuthorizationDecision,
  IAuthorizationClient,
  IConfirmationChallengeClient,
  SessionConfirmation,
  ISessionConfirmationStore,
  UserConfirmationRequest,
  UserConfirmationResponse,
  IUserConfirmationGateway,
  ActionAuditPayload,
  IAuditEmitter,
  ActionExecutorConfig,
  ActionExecutorDependencies,
  IActionExecutor,
} from './action-executor.js';

// Dry-run preview interfaces
export type {
  IEffectPredictor,
  IDryRunPreviewService,
} from './dry-run.js';

// OS abstraction interfaces
export type {
  OSPlatform,
  OSOperationResult,
  IOSAdapter,
  IOSAbstractionLayer,
} from './os-abstraction.js';

// Rollback tracking interfaces
export type {
  RollbackConfig,
  IRollbackStore,
  IRollbackStepGenerator,
  IRollbackTracker,
} from './rollback.js';

// Self-healing selector interfaces
export type {
  ElementSelector,
  StructuralHint,
  VisualDescriptor,
  SelectorHealResult,
  SelectorStrategy,
  StrategyAttempt,
  IHealingStrategy,
  HealingContext,
  PageElement,
  SelectorMigrationLog,
  ISelectorAuditEmitter,
  ISelfHealingSelector,
} from './self-healing.js';

// Idempotency, timeout, and integrated executor interfaces
export type {
  CachedActionResult,
  IIdempotencyStore,
  TimeoutConfig,
  TimeoutResult,
  ITimeoutEnforcer,
  ActionAuditCategory,
  AuditEmitResult,
  IIntegratedAuditEmitter,
  ActionExecutorFn,
  IActionExecutorService,
} from './idempotency-timeout.js';
