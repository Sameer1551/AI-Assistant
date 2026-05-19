/**
 * @module personality
 * Data models for the Personality_Service.
 *
 * The Personality_Service adapts the Platform's communication style based on
 * context and cognitive state while maintaining core character stability.
 * It manages Style_Profiles, drift detection, and style directive injection.
 *
 * @see Requirement 38.1
 */

import type { UnitScore } from './branded.js';

/**
 * Named style profiles that the Personality_Service selects based on context.
 * Each profile defines a distinct communication configuration.
 */
export type StyleProfileName =
  | 'deep_work'
  | 'casual_chat'
  | 'late_night'
  | 'high_stress'
  | 'morning_briefing';

/**
 * Verbosity level controlling how much detail the assistant provides.
 */
export type Verbosity = 'minimal' | 'moderate' | 'full';

/**
 * Tone of communication determining the emotional register.
 */
export type StyleTone = 'direct' | 'warm' | 'calm' | 'grounding' | 'energising';

/**
 * Formality level of communication.
 */
export type Formality = 'informal' | 'neutral' | 'formal';

/**
 * Energy level of communication affecting pacing and enthusiasm.
 */
export type Energy = 'low' | 'medium' | 'high';

/**
 * Preferred output format for structured responses.
 */
export type FormatPreference = 'bullet_points' | 'full_sentences' | 'structured_agenda';

/**
 * A named configuration of communication parameters that the Personality_Service
 * selects based on context. Defined profiles include deep_work, casual_chat,
 * late_night, high_stress, and morning_briefing.
 */
export interface StyleProfile {
  /** The named profile identifier */
  readonly name: StyleProfileName;

  /** How much detail to include in responses */
  readonly verbosity: Verbosity;

  /** The emotional register of communication */
  readonly tone: StyleTone;

  /** How formal the language should be */
  readonly formality: Formality;

  /** The energy and pacing of communication */
  readonly energy: Energy;

  /** Preferred output structure */
  readonly format_preference: FormatPreference;

  /** Whether to include greetings and social niceties */
  readonly pleasantries: boolean;
}

/**
 * Defines the immutable core character of the assistant.
 * Character values and constraints remain stable regardless of style profile changes.
 */
export interface CoreCharacterDefinition {
  /** Immutable character values that define the assistant's identity */
  readonly values: readonly string[];

  /** Behavioral constraints the assistant must always follow */
  readonly behavioral_constraints: readonly string[];

  /** Behaviors the assistant must never exhibit */
  readonly prohibited_behaviors: readonly string[];

  /** Version identifier for this character definition */
  readonly version: string;
}

/**
 * Result of a drift benchmark evaluation that measures whether the assistant's
 * personality has deviated from its core character definition over time.
 */
export interface DriftBenchmarkResult {
  /** Unique identifier for this benchmark run */
  readonly benchmark_id: string;

  /** ISO 8601 timestamp when the benchmark was executed */
  readonly timestamp: string;

  /** Overall character consistency score in [0.0, 1.0]; lower indicates more drift */
  readonly overall_score: UnitScore;

  /** Per-dimension scores (e.g., "empathy", "directness", "helpfulness") */
  readonly dimension_scores: Readonly<Record<string, number>>;

  /** Number of prompts evaluated in this benchmark */
  readonly prompts_evaluated: number;

  /** Whether drift was detected beyond the configured threshold */
  readonly drift_detected: boolean;

  /** Whether an alert was emitted due to drift detection */
  readonly alert_emitted: boolean;
}
