/**
 * Planning data models for the Planning_Service.
 *
 * The Planning_Service performs hierarchical 3-level planning (strategic, tactical,
 * operational) with dependency graph management, cycle detection, bottom-up execution,
 * and subtree replanning on failure.
 *
 * @module planning
 */

/**
 * Hierarchical level of a plan node.
 * - strategic: High-level goals and objectives
 * - tactical: Mid-level approaches and strategies
 * - operational: Low-level executable actions
 */
export type PlanLevel = 'strategic' | 'tactical' | 'operational';

/**
 * Execution status of a plan node.
 */
export type PlanNodeStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * A hierarchical plan tree containing nodes at strategic, tactical, and operational levels.
 */
export interface PlanTree {
  /** Unique identifier for this plan */
  readonly plan_id: string;
  /** Tenant that owns this plan */
  readonly tenant_id: string;
  /** Principal who created this plan */
  readonly principal_id: string;
  /** The root goal this plan is designed to achieve */
  readonly root_goal: string;
  /** All nodes in the plan tree */
  readonly nodes: PlanNode[];
  /** ISO 8601 timestamp of plan creation */
  readonly created_at: string;
  /** Overall status of the plan */
  readonly status: PlanNodeStatus;
  /** Maximum time allowed for the entire plan in seconds */
  readonly timeout_seconds: number;
}

/**
 * A single node in the plan tree, representing a task at a specific hierarchical level.
 */
export interface PlanNode {
  /** Unique identifier for this node */
  readonly node_id: string;
  /** The plan this node belongs to */
  readonly plan_id: string;
  /** Hierarchical level of this node */
  readonly level: PlanLevel;
  /** Parent node identifier, absent for root nodes */
  readonly parent_node_id?: string;
  /** Human-readable description of what this node accomplishes */
  readonly description: string;
  /** Current execution status */
  readonly status: PlanNodeStatus;
  /** Node IDs that must complete before this node can start */
  readonly dependencies: readonly string[];
  /** Maximum time allowed for this node in seconds */
  readonly timeout_seconds: number;
  /** ISO 8601 timestamp of when execution started */
  readonly started_at?: string;
  /** ISO 8601 timestamp of when execution completed */
  readonly completed_at?: string;
  /** Reason for failure, if status is 'failed' */
  readonly failure_reason?: string;
  /** Child node IDs in the hierarchy */
  readonly children: readonly string[];
}

/**
 * A flattened checklist view of a plan tree for progress tracking.
 */
export interface PlanChecklist {
  /** The plan this checklist represents */
  readonly plan_id: string;
  /** Ordered list of checklist items */
  readonly items: ChecklistItem[];
}

/**
 * A single item in a plan checklist, representing a node with indentation for hierarchy.
 */
export interface ChecklistItem {
  /** The plan node this item represents */
  readonly node_id: string;
  /** Hierarchical level of the node */
  readonly level: PlanLevel;
  /** Human-readable description */
  readonly description: string;
  /** Current execution status */
  readonly status: PlanNodeStatus;
  /** Indentation level for display (0 = root) */
  readonly indent_level: number;
}
