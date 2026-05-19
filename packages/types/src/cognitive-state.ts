/**
 * @module cognitive-state
 * Data models for the Cognitive_State_Service.
 *
 * The Cognitive_State_Service models the End_User's cognitive state from
 * observable signals, updated every 30 seconds. It drives interrupt decisions
 * and LLM prompt adaptation.
 *
 * @see Requirement 37.1
 */

import type { UnitScore } from './branded.js';

/**
 * Response style options derived from cognitive state analysis.
 * Determines how verbose and structured the assistant's responses should be.
 */
export type CognitiveResponseStyle = 'extremely_brief' | 'brief' | 'normal' | 'detailed';

/**
 * Tone options for cognitive directives.
 * Determines the emotional register of the assistant's communication.
 */
export type CognitiveTone = 'calm' | 'energetic' | 'neutral' | 'grounding';

/**
 * A structured vector containing 7 cognitive dimensions, all normalized to [0.0, 1.0].
 * Updated every 30 seconds from observable signals (typing patterns, application switches,
 * time of day, error frequency, etc.).
 */
export interface CognitiveState {
  /** Unique identifier for this state snapshot */
  readonly state_id: string;

  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Authenticated user principal */
  readonly principal_id: string;

  /** ISO 8601 timestamp when this state was computed */
  readonly timestamp: string;

  /** How deeply the user is engaged in their current task; high values indicate flow state */
  readonly focus_depth: UnitScore;

  /** How tolerant the user is of interruptions; low values mean do not disturb */
  readonly interruption_tolerance: UnitScore;

  /** Estimated fatigue level; high values indicate the user may need a break */
  readonly fatigue_score: UnitScore;

  /** Cost of switching the user's attention to a new task; high values mean switching is expensive */
  readonly task_switch_cost: UnitScore;

  /** Current mental load; high values indicate the user is near capacity */
  readonly cognitive_load: UnitScore;

  /** External urgency pressure from deadlines, meetings, etc. */
  readonly urgency_pressure: UnitScore;

  /** Probability that the user is experiencing frustration */
  readonly frustration_probability: UnitScore;
}

/**
 * A directive generated from cognitive state analysis, injected into the LLM system prompt
 * to adapt response style and tone to the user's current cognitive condition.
 */
export interface CognitiveDirective {
  /** The directive text injected into the LLM system prompt */
  readonly directive_text: string;

  /** Response verbosity level derived from cognitive state */
  readonly response_style: CognitiveResponseStyle;

  /** Communication tone derived from cognitive state */
  readonly tone: CognitiveTone;

  /** The cognitive state snapshot that produced this directive */
  readonly based_on_state: CognitiveState;
}
