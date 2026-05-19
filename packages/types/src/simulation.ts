/**
 * Simulation data models for the Simulation_Service.
 *
 * The Simulation_Service predicts outcomes of proposed actions before execution,
 * returning success probability, failure modes, rollback cost, and recommendations.
 *
 * @module simulation
 */

/**
 * Cost classification for rolling back an action after execution.
 */
export type RollbackCost = 'trivial' | 'moderate' | 'high' | 'irreversible';

/**
 * Recommendation produced by the simulation engine after evaluating an action.
 */
export type SimulationRecommendation = 'proceed' | 'proceed_with_caution' | 'abort';

/**
 * A structured prediction returned by the Simulation_Service before action execution.
 * Contains predicted outcome, success probability, failure modes, expected duration,
 * rollback cost, side effects, resource delta, confidence, and recommendation.
 */
export interface SimulationResult {
  /** Unique identifier for this simulation run */
  readonly simulation_id: string;
  /** The action being simulated */
  readonly action_id: string;
  /** Human-readable description of the predicted outcome */
  readonly predicted_outcome: string;
  /** Probability of success in the range [0.0, 1.0] */
  readonly success_probability: number;
  /** Identified failure modes, up to 3 */
  readonly failure_modes: FailureMode[];
  /** Expected duration of the action in seconds */
  readonly expected_duration_seconds: number;
  /** Classification of how costly it would be to reverse the action */
  readonly rollback_cost: RollbackCost;
  /** List of predicted side effects */
  readonly side_effects: readonly string[];
  /** Predicted resource consumption changes */
  readonly resource_delta: ResourceDelta;
  /** Overall confidence in the simulation prediction [0.0, 1.0] */
  readonly confidence: number;
  /** Engine recommendation based on the simulation analysis */
  readonly recommendation: SimulationRecommendation;
  /** Time taken to run the simulation in milliseconds */
  readonly simulation_duration_ms: number;
  /** ISO 8601 timestamp of when the simulation was performed */
  readonly timestamp: string;
}

/**
 * A potential failure mode identified during simulation.
 */
export interface FailureMode {
  /** Human-readable description of the failure scenario */
  readonly description: string;
  /** Probability of this failure occurring [0.0, 1.0] */
  readonly probability: number;
  /** Optional suggested mitigation strategy */
  readonly mitigation?: string;
}

/**
 * Predicted resource consumption changes resulting from an action.
 */
export interface ResourceDelta {
  /** Net change in disk usage in bytes (positive = consumption, negative = freed) */
  readonly disk_bytes: number;
  /** Net change in memory usage in bytes */
  readonly memory_bytes: number;
  /** Number of network calls the action will make */
  readonly network_calls: number;
  /** Estimated cost in normalized cost units */
  readonly estimated_cost_units: number;
}
