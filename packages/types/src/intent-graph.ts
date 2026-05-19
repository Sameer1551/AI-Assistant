/**
 * @module intent-graph
 * Data models for the Intent_Graph_Service.
 *
 * The Intent_Graph_Service maintains a living directed graph of End_User goals,
 * projects, blockers, priorities, and their relationships. It extracts intent
 * from conversations via LLM analysis and injects top-priority nodes into LLM context.
 *
 * @see Requirement 40.1
 */

import type { UnitScore } from './branded.js';

/**
 * The type of an intent node in the graph.
 * Each type represents a different category of user intent or concern.
 */
export type IntentNodeType =
  | 'project'
  | 'goal'
  | 'blocker'
  | 'habit'
  | 'deadline'
  | 'frustration';

/**
 * The type of a directed relationship between intent nodes.
 * Constrains the set of valid edge relations in the intent graph.
 */
export type IntentEdgeRelation =
  | 'blocks'
  | 'requires'
  | 'part_of'
  | 'related_to'
  | 'caused_by';

/**
 * Status of an intent node indicating its lifecycle state.
 */
export type IntentNodeStatus = 'active' | 'paused' | 'completed' | 'abandoned';

/**
 * A node in the Intent Graph representing a project, goal, blocker, habit,
 * deadline, or frustration. Each node carries priority, progress, urgency,
 * and emotional weight scores.
 */
export interface IntentNode {
  /** Unique identifier for this node */
  readonly node_id: string;

  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Authenticated user principal who owns this node */
  readonly principal_id: string;

  /** The category of intent this node represents */
  readonly type: IntentNodeType;

  /** Human-readable title for this intent */
  readonly title: string;

  /** Optional detailed description */
  readonly description?: string;

  /** Priority score in [0.0, 1.0]; higher means more important */
  readonly priority: UnitScore;

  /** Urgency score in [0.0, 1.0]; higher means more time-sensitive */
  readonly urgency: UnitScore;

  /** Progress toward completion in [0.0, 1.0]; 1.0 means done */
  readonly progress: UnitScore;

  /** Emotional weight in [0.0, 1.0]; how much emotional significance this carries */
  readonly emotional_weight: UnitScore;

  /** Current lifecycle status of this node */
  readonly status: IntentNodeStatus;

  /** ISO 8601 timestamp of last activity on this node */
  readonly last_active: string;

  /** ISO 8601 timestamp when this node was created */
  readonly created_at: string;

  /** Arbitrary key-value metadata for extensibility */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * A directed edge in the Intent Graph representing a relationship between two nodes.
 * The relation type is constrained to {blocks, requires, part_of, related_to, caused_by}.
 */
export interface IntentEdge {
  /** Unique identifier for this edge */
  readonly edge_id: string;

  /** The node this edge originates from */
  readonly source_node_id: string;

  /** The node this edge points to */
  readonly target_node_id: string;

  /** The type of relationship between source and target */
  readonly relation: IntentEdgeRelation;

  /** Strength of the relationship in [0.0, 1.0] */
  readonly weight: UnitScore;

  /** ISO 8601 timestamp when this edge was created */
  readonly created_at: string;
}
