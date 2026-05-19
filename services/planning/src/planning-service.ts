/**
 * @module planning-service
 * Planning_Service: Hierarchical planning and dependency management.
 *
 * @see Requirements 47.1–47.7
 */

import type { PlanTree, PlanNode, PlanChecklist, ChecklistItem, PlanLevel, PlanNodeStatus } from '@may/types';
import type {
  IPlanningIdGenerator,
  IPlanningClock,
  IAuditPublisher,
  IPlanningStore,
} from './interfaces/index.js';

export interface PlanningServiceDeps {
  readonly idGenerator: IPlanningIdGenerator;
  readonly clock: IPlanningClock;
  readonly auditPublisher: IAuditPublisher;
  readonly store: IPlanningStore;
}

export class PlanningService {
  private readonly idGenerator: IPlanningIdGenerator;
  private readonly clock: IPlanningClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly store: IPlanningStore;

  constructor(deps: PlanningServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.store = deps.store;
  }

  /**
   * Validates that the nodes do not contain dependency cycles.
   * Throws Error if cycle detected.
   *
   * @see Requirement 47.3
   */
  private validateNoCycles(nodes: PlanNode[]): void {
    const adj = new Map<string, string[]>();
    nodes.forEach(n => adj.set(n.node_id, [...n.dependencies]));

    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (nodeId: string) => {
      if (stack.has(nodeId)) {
        throw new Error(`Dependency cycle detected involving node ${nodeId}`);
      }
      if (visited.has(nodeId)) {
        return;
      }
      visited.add(nodeId);
      stack.add(nodeId);

      const neighbors = adj.get(nodeId) || [];
      for (const n of neighbors) {
        dfs(n);
      }
      stack.delete(nodeId);
    };

    for (const node of nodes) {
      if (!visited.has(node.node_id)) {
        dfs(node.node_id);
      }
    }
  }

  /**
   * Create a plan from an initial set of nodes.
   */
  async createPlan(tenantId: string, principalId: string, rootGoal: string, timeoutSeconds: number, nodes: PlanNode[]): Promise<PlanTree> {
    this.validateNoCycles(nodes); // Prop 77

    const plan: PlanTree = {
      plan_id: this.idGenerator.uuid(),
      tenant_id: tenantId,
      principal_id: principalId,
      root_goal: rootGoal,
      nodes,
      created_at: this.clock.nowISO(),
      status: 'pending',
      timeout_seconds: timeoutSeconds,
    };

    await this.store.savePlan(plan);
    return plan;
  }

  /**
   * Determine which nodes are eligible to start.
   * Execute bottom-up: only nodes where all dependencies are 'done' can run.
   *
   * @see Requirement 47.4
   */
  getExecutableNodes(plan: PlanTree): PlanNode[] {
    const nodesById = new Map(plan.nodes.map(n => [n.node_id, n]));
    
    return plan.nodes.filter(node => {
      if (node.status !== 'pending') return false;
      
      // All dependencies must be done
      return node.dependencies.every(depId => {
        const dep = nodesById.get(depId);
        return dep && dep.status === 'done';
      });
    });
  }

  /**
   * Replace a failed node and its subtree with a new set of nodes.
   *
   * @see Requirement 47.5
   */
  async replanSubtree(planId: string, failedNodeId: string, newNodes: PlanNode[]): Promise<PlanTree> {
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new Error('Plan not found');

    const nodesById = new Map(plan.nodes.map(n => [n.node_id, n]));
    
    // Find all nodes in the subtree of the failed node
    const subtreeNodes = new Set<string>();
    const findSubtree = (nodeId: string) => {
      subtreeNodes.add(nodeId);
      const node = nodesById.get(nodeId);
      if (node) {
        node.children.forEach(c => findSubtree(c));
      }
    };
    findSubtree(failedNodeId);

    // Filter out the old subtree
    const remainingNodes = plan.nodes.filter(n => !subtreeNodes.has(n.node_id));
    
    // Add new nodes
    const allNodes = [...remainingNodes, ...newNodes];

    // Re-validate cycles
    this.validateNoCycles(allNodes);

    const newPlan: PlanTree = { ...plan, nodes: allNodes };
    await this.store.savePlan(newPlan);

    await this.auditPublisher.publishAudit({
      type: 'plan_subtree_replanned',
      planId,
      failedNodeId,
      timestamp: this.clock.nowISO(),
    });

    return newPlan;
  }
}
