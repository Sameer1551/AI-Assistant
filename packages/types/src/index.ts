/**
 * @may/types - Shared type definitions and interfaces for the May platform
 *
 * This package contains all shared contracts, interfaces, and type definitions
 * used across services in the Enterprise AI Assistant Platform.
 */

// Branded numeric types
export { isUnitScore, toUnitScore } from './branded.js';
export type { UnitScore } from './branded.js';

// Context Intelligence (Requirement 36.1)
export type { ContextField, ContextPacket } from './context-intelligence.js';

// Cognitive State (Requirement 37.1)
export type {
  CognitiveDirective,
  CognitiveResponseStyle,
  CognitiveState,
  CognitiveTone,
} from './cognitive-state.js';

// Personality (Requirement 38.1)
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

// Proactive Intelligence (Requirement 39.1)
export type {
  DeliveryDecision,
  InterruptBudgetStatus,
  ProactiveSignal,
} from './proactive.js';

// Intent Graph (Requirement 40.1)
export type {
  IntentEdge,
  IntentEdgeRelation,
  IntentNode,
  IntentNodeStatus,
  IntentNodeType,
} from './intent-graph.js';

// Knowledge Grounding (Requirement 41.1)
export type {
  FreshnessClassification,
  FreshnessTier,
  GroundedClaim,
  GroundedClaimSource,
  GroundedContext,
} from './knowledge-grounding.js';
