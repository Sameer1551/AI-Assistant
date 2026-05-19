/**
 * Self-improvement and fine-tuning data models.
 *
 * The Self_Improvement_Service runs weekly MEASURE/IDENTIFY/PROPOSE/TEST/DEPLOY
 * improvement cycles, maintains prompt versioning, deploys only verified improvements,
 * and auto-rollbacks on regression.
 *
 * The Fine_Tuning_Service manages local-only LoRA fine-tuning on conversation history
 * with review gate, adapter versioning, regression testing, and Throttle_Level gating.
 *
 * @module self-improvement
 */

/**
 * Phase of an improvement cycle.
 */
export type ImprovementPhase =
  | 'MEASURE'
  | 'IDENTIFY'
  | 'PROPOSE'
  | 'TEST'
  | 'DEPLOY'
  | 'COMPLETED'
  | 'SKIPPED';

/**
 * Decision outcome for an improvement cycle candidate.
 */
export type ImprovementDecision = 'promoted' | 'discarded' | 'pending';

/**
 * A single improvement cycle tracking the progression from measurement through deployment.
 */
export interface ImprovementCycle {
  /** Unique identifier for this cycle */
  readonly cycle_id: string;
  /** ISO 8601 timestamp of when the cycle started */
  readonly timestamp: string;
  /** Current phase of the improvement cycle */
  readonly phase: ImprovementPhase;
  /** Baseline benchmark score before improvement */
  readonly baseline_score: number;
  /** Candidate benchmark score after proposed improvement */
  readonly candidate_score?: number;
  /** Whether the candidate was promoted, discarded, or is still pending */
  readonly decision: ImprovementDecision;
  /** Prompt version identifier before this cycle */
  readonly prompt_version_before: string;
  /** Prompt version identifier after this cycle, if promoted */
  readonly prompt_version_after?: string;
  /** Number of user corrections analyzed in this cycle */
  readonly corrections_analyzed: number;
}

/**
 * A versioned prompt with benchmark scoring and lifecycle tracking.
 */
export interface PromptVersion {
  /** Unique version identifier */
  readonly version_id: string;
  /** The prompt content */
  readonly prompt_content: string;
  /** Benchmark score achieved by this version */
  readonly benchmark_score: number;
  /** ISO 8601 timestamp of creation */
  readonly created_at: string;
  /** ISO 8601 timestamp of when this version was promoted to active */
  readonly promoted_at?: string;
  /** ISO 8601 timestamp of when this version was rolled back */
  readonly rolled_back_at?: string;
  /** Whether this version is currently the active prompt */
  readonly is_active: boolean;
}

/**
 * A LoRA (Low-Rank Adaptation) adapter trained on local conversation history.
 * Augments a base model without modifying it, versioned and subject to regression testing.
 */
export interface LoRAAdapter {
  /** Unique identifier for this adapter */
  readonly adapter_id: string;
  /** Version number of this adapter */
  readonly version: number;
  /** The base model this adapter augments */
  readonly base_model_id: string;
  /** Number of training data samples used */
  readonly training_data_count: number;
  /** Benchmark score achieved with this adapter */
  readonly benchmark_score: number;
  /** Baseline benchmark score before training */
  readonly pre_training_baseline: number;
  /** ISO 8601 timestamp of creation */
  readonly created_at: string;
  /** Whether this adapter is currently active */
  readonly is_active: boolean;
  /** Whether this adapter has been rolled back */
  readonly rolled_back: boolean;
}
