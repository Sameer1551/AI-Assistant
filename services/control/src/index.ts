/**
 * @may/control - Control Service
 *
 * Provides action execution with risk-level enforcement, idempotency,
 * audit emission, dry-run preview, rollback tracking, self-healing
 * browser selectors, and OS abstraction.
 */

// Interfaces (dependency injection contracts)
export type {
  IEffectPredictor,
  IDryRunPreviewService,
  IClock,
  IIdGenerator,
  RollbackConfig,
  IRollbackStore,
  IRollbackStepGenerator,
  IRollbackTracker,
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
  OSPlatform,
  OSOperationResult,
  IOSAdapter,
  IOSAbstractionLayer,
  // Idempotency, timeout, and integrated executor interfaces
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
} from './interfaces/index.js';

// Dry-run preview service
export { DryRunPreviewService } from './dry-run-preview-service.js';
export type { DryRunPreviewServiceDependencies } from './dry-run-preview-service.js';

// Rollback tracker
export { RollbackTracker, DEFAULT_ROLLBACK_RETENTION_HOURS } from './rollback-tracker.js';
export type { RollbackTrackerDependencies } from './rollback-tracker.js';

// In-memory rollback store
export { InMemoryRollbackStore } from './in-memory-rollback-store.js';

// Self-healing selector
export {
  SelfHealingSelector,
  AccessibilityLabelStrategy,
  TextContentStrategy,
  VisualSimilarityStrategy,
  DOMStructureStrategy,
  MIN_HEAL_CONFIDENCE,
} from './self-healing-selector.js';
export type { SelfHealingSelectorDependencies } from './self-healing-selector.js';

// OS abstraction layer
export { OSAbstractionLayer, detectPlatform } from './os-abstraction-layer.js';

// Idempotency store
export { InMemoryIdempotencyStore } from './in-memory-idempotency-store.js';

// Timeout enforcer
export { TimeoutEnforcer, TimeoutError, DEFAULT_TIMEOUT_CONFIG } from './timeout-enforcer.js';

// Action audit emitter (integrated)
export { ActionAuditEmitter } from './action-audit-emitter.js';
export type { IAuditServiceClient } from './action-audit-emitter.js';

// Action executor service (integrated idempotency + timeout + audit)
export { ActionExecutorService } from './action-executor-service.js';
