/**
 * Reflection data models for the Reflection_Service.
 *
 * The Reflection_Service evaluates completed actions against predicted outcomes,
 * identifies patterns in failures, extracts lessons, and feeds improvements
 * into the Self_Improvement_Service.
 *
 * @module reflection
 */

/**
 * Signal indicating how the user responded to an action's outcome.
 */
export type UserSignal = 'accepted' | 'rejected' | 'modified' | 'ignored';

/**
 * A record of reflection on a completed action, comparing intended vs actual outcome.
 */
export interface ReflectionRecord {
  /** Unique identifier for this reflection */
  readonly reflection_id: string;
  /** Tenant that owns this reflection */
  readonly tenant_id: string;
  /** Principal associated with this reflection */
  readonly principal_id: string;
  /** The action that was reflected upon */
  readonly action_id: string;
  /** Human-readable description of the action */
  readonly action_description: string;
  /** What the action was intended to achieve */
  readonly intended_outcome: string;
  /** What actually happened */
  readonly actual_outcome: string;
  /** How the user responded to the outcome */
  readonly user_signal: UserSignal;
  /** Score indicating how useful the action was [0.0, 1.0] */
  readonly usefulness_score: number;
  /** One-sentence lesson extracted from this reflection */
  readonly lesson: string;
  /** Link to the pre-execution simulation prediction, if available */
  readonly simulation_result_id?: string;
  /** How accurate the simulation prediction was [0.0, 1.0] */
  readonly prediction_accuracy?: number;
  /** ISO 8601 timestamp of when the reflection was created */
  readonly timestamp: string;
  /** ISO 8601 timestamp of when this record expires (retention-driven) */
  readonly expires_at: string;
}

/**
 * A recurring pattern of failures identified across multiple actions.
 */
export interface FailurePattern {
  /** Unique identifier for this pattern */
  readonly pattern_id: string;
  /** Human-readable description of the failure pattern */
  readonly description: string;
  /** Number of times this pattern has been observed */
  readonly occurrence_count: number;
  /** ISO 8601 timestamp of first observation */
  readonly first_seen: string;
  /** ISO 8601 timestamp of most recent observation */
  readonly last_seen: string;
  /** Action types affected by this pattern */
  readonly affected_action_types: readonly string[];
  /** Suggested strategy to mitigate this failure pattern */
  readonly suggested_mitigation: string;
}
