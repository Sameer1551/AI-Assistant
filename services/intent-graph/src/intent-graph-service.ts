/**
 * @module intent-graph-service
 * Intent_Graph_Service: Maintains user goals, projects, blockers, priorities.
 *
 * @see Requirements 40.1–40.7
 */

import type { IntentNode, IntentEdge, IntentNodeType, IntentEdgeRelation } from '@may/types';
import { toUnitScore } from '@may/types';
import type {
  IIntentIdGenerator,
  IIntentClock,
  IAuditPublisher,
  IntentGraphStore,
} from './interfaces/index.js';

export interface IntentGraphServiceDeps {
  readonly idGenerator: IIntentIdGenerator;
  readonly clock: IIntentClock;
  readonly auditPublisher: IAuditPublisher;
  readonly store: IntentGraphStore;
}

export class IntentGraphService {
  private readonly idGenerator: IIntentIdGenerator;
  private readonly clock: IIntentClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly store: IntentGraphStore;

  constructor(deps: IntentGraphServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.store = deps.store;
  }

  /** Clamp to [0, 1] */
  private clamp(v: number): number {
    return Math.max(0.0, Math.min(1.0, v));
  }

  async addNode(
    tenantId: string,
    principalId: string,
    type: IntentNodeType, // Enforced by TypeScript to valid set (Requirement 40.1 / Prop 60)
    title: string,
    params: { priority: number; urgency: number; emotional_weight: number; description?: string; metadata?: Record<string, string> }
  ): Promise<IntentNode> {
    const node: IntentNode = {
      node_id: this.idGenerator.uuid(),
      tenant_id: tenantId,
      principal_id: principalId,
      type,
      title,
      description: params.description,
      priority: toUnitScore(this.clamp(params.priority)),
      urgency: toUnitScore(this.clamp(params.urgency)),
      progress: toUnitScore(0.0),
      emotional_weight: toUnitScore(this.clamp(params.emotional_weight)),
      status: 'active',
      last_active: this.clock.nowISO(),
      created_at: this.clock.nowISO(),
      metadata: params.metadata ?? {},
    };

    await this.store.createNode(node);
    return node;
  }

  async addEdge(
    sourceNodeId: string,
    targetNodeId: string,
    relation: IntentEdgeRelation, // Enforced by TypeScript (Prop 60)
    weight: number
  ): Promise<IntentEdge> {
    const edge: IntentEdge = {
      edge_id: this.idGenerator.uuid(),
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      relation,
      weight: toUnitScore(this.clamp(weight)),
      created_at: this.clock.nowISO(),
    };

    await this.store.createEdge(edge);
    return edge;
  }

  /**
   * Remove node and all connected edges within 60s, emit audit event
   * @see Requirement 40.7
   */
  async deleteNode(tenantId: string, principalId: string, nodeId: string): Promise<void> {
    const node = await this.store.getNode(nodeId);
    if (!node || node.tenant_id !== tenantId || node.principal_id !== principalId) {
      return; // Not found or access denied
    }

    // Find connected edges
    const edges = await this.store.getEdgesForNode(nodeId);
    
    // Delete edges
    for (const edge of edges) {
      await this.store.deleteEdge(edge.edge_id);
    }

    // Delete node
    await this.store.deleteNode(nodeId);

    // Emit audit event
    await this.auditPublisher.publishAudit({
      type: 'intent_node_deleted',
      tenantId,
      principalId,
      nodeId,
      timestamp: this.clock.nowISO(),
      edgesRemoved: edges.length,
    });
  }

  /**
   * Inject top 5 most active nodes (ranked by priority × urgency × recency) into every LLM call
   * @see Requirement 40.4
   */
  async getTopNodesForInjection(tenantId: string, principalId: string): Promise<IntentNode[]> {
    const nodes = await this.store.getNodesForPrincipal(tenantId, principalId);
    const nowMs = this.clock.nowMs();

    const scoredNodes = nodes.map(node => {
      const activeMs = new Date(node.last_active).getTime();
      const ageMs = Math.max(0, nowMs - activeMs);
      const halfLifeMs = 7 * 24 * 3600 * 1000; // 7 days
      const recency = Math.max(0.0, Math.pow(0.5, ageMs / halfLifeMs));
      
      const compositeScore = node.priority * node.urgency * recency;
      return { node, score: compositeScore };
    });

    // Sort descending by score
    scoredNodes.sort((a, b) => b.score - a.score);

    // Return top 5
    return scoredNodes.slice(0, 5).map(sn => sn.node);
  }

  /**
   * Update last_active when user context matches node
   * @see Requirement 40.5
   */
  async markNodeActive(tenantId: string, principalId: string, nodeId: string): Promise<void> {
    const node = await this.store.getNode(nodeId);
    if (!node || node.tenant_id !== tenantId || node.principal_id !== principalId) {
      return;
    }

    const updatedNode = { ...node, last_active: this.clock.nowISO() };
    await this.store.updateNode(updatedNode);
  }
}
