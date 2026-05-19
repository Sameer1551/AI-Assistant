/**
 * Goal and milestone data models for the Goal_Engine_Service.
 *
 * The Goal_Engine_Service manages long-horizon goals, auto-decomposes them into
 * milestones, tracks progress, detects blockers, suggests optimal next actions,
 * and executes weekly goal reviews.
 *
 * @module goal
 */

/**
 * Status classification for a long-horizon goal.
 */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';

/**
 * Status classification for a milestone within a goal.
 */
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * A long-horizon goal with milestones, progress tracking, and blocker detection.
 */
export interface Goal {
  /** Unique identifier for this goal */
  readonly goal_id: string;
  /** Tenant that owns this goal */
  readonly tenant_id: string;
  /** Principal who created/owns this goal */
  readonly principal_id: string;
  /** Short title of the goal */
  readonly title: string;
  /** Detailed description of what the goal entails */
  readonly description: string;
  /** Why this goal matters to the user */
  readonly motivation: string;
  /** Priority score [0.0, 1.0] */
  readonly priority: number;
  /** Optional deadline in ISO 8601 format */
  readonly deadline?: string;
  /** Current status of the goal */
  readonly status: GoalStatus;
  /** Progress as ratio of completed milestones to total milestones [0.0, 1.0] */
  readonly progress: number;
  /** Ordered list of milestones for this goal */
  readonly milestones: Milestone[];
  /** ISO 8601 timestamp of goal creation */
  readonly created_at: string;
  /** ISO 8601 timestamp of last progress update */
  readonly last_progress_at: string;
  /** ISO 8601 timestamp of when the goal became blocked, if applicable */
  readonly blocked_since?: string;
}

/**
 * A discrete milestone within a goal, representing a measurable step toward completion.
 */
export interface Milestone {
  /** Unique identifier for this milestone */
  readonly milestone_id: string;
  /** The goal this milestone belongs to */
  readonly goal_id: string;
  /** Description of what this milestone achieves */
  readonly description: string;
  /** Criteria that define when this milestone is complete */
  readonly success_criteria: string;
  /** Estimated hours to complete this milestone */
  readonly estimated_hours: number;
  /** Current status of the milestone */
  readonly status: MilestoneStatus;
  /** ISO 8601 timestamp of completion, if completed */
  readonly completed_at?: string;
  /** Order within the goal's milestone list (0-indexed) */
  readonly order: number;
}

/**
 * A weekly review report summarizing goal progress, blockers, and recommended actions.
 */
export interface WeeklyReviewReport {
  /** Unique identifier for this review */
  readonly review_id: string;
  /** ISO 8601 timestamp of when the review was generated */
  readonly timestamp: string;
  /** Total number of goals reviewed */
  readonly goals_reviewed: number;
  /** Summary of currently active goals */
  readonly active_goals: GoalSummary[];
  /** Summary of currently blocked goals */
  readonly blocked_goals: GoalSummary[];
  /** Summary of goals completed during this review period */
  readonly completed_this_week: GoalSummary[];
  /** Recommended next actions across all goals */
  readonly recommended_next_actions: NextActionSuggestion[];
}

/**
 * A condensed summary of a goal for use in reports and listings.
 */
export interface GoalSummary {
  /** Goal identifier */
  readonly goal_id: string;
  /** Goal title */
  readonly title: string;
  /** Current progress [0.0, 1.0] */
  readonly progress: number;
  /** Current status */
  readonly status: GoalStatus;
  /** List of blockers, if any */
  readonly blockers?: readonly string[];
}

/**
 * A suggested next action to advance a goal, scored by composite priority.
 */
export interface NextActionSuggestion {
  /** The goal this action advances */
  readonly goal_id: string;
  /** The specific milestone this action targets */
  readonly milestone_id: string;
  /** Human-readable description of the suggested action */
  readonly description: string;
  /** Composite score based on priority, inverse progress, and deadline urgency */
  readonly score: number;
}
