import type { IntentNode, IntentEdge } from '@may/types';
import type { IntentGraphStore } from './interfaces/index.js';

export class InMemoryIntentStore implements IntentGraphStore {
  private nodes = new Map<string, IntentNode>();
  private edges = new Map<string, IntentEdge>();

  async createNode(node: IntentNode): Promise<void> {
    this.nodes.set(node.node_id, node);
  }

  async updateNode(node: IntentNode): Promise<void> {
    this.nodes.set(node.node_id, node);
  }

  async deleteNode(nodeId: string): Promise<void> {
    this.nodes.delete(nodeId);
    // Note: cascade delete of edges handled by service
  }

  async getNode(nodeId: string): Promise<IntentNode | undefined> {
    return this.nodes.get(nodeId);
  }

  async getNodesForPrincipal(tenantId: string, principalId: string): Promise<IntentNode[]> {
    const result: IntentNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.tenant_id === tenantId && node.principal_id === principalId) {
        result.push(node);
      }
    }
    return result;
  }

  async createEdge(edge: IntentEdge): Promise<void> {
    this.edges.set(edge.edge_id, edge);
  }

  async deleteEdge(edgeId: string): Promise<void> {
    this.edges.delete(edgeId);
  }

  async getEdgesForNode(nodeId: string): Promise<IntentEdge[]> {
    const result: IntentEdge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.source_node_id === nodeId || edge.target_node_id === nodeId) {
        result.push(edge);
      }
    }
    return result;
  }

  async getEdgesForPrincipal(tenantId: string, principalId: string): Promise<IntentEdge[]> {
    const nodes = await this.getNodesForPrincipal(tenantId, principalId);
    const nodeIds = new Set(nodes.map(n => n.node_id));
    
    const result: IntentEdge[] = [];
    for (const edge of this.edges.values()) {
      // If either source or target belongs to the principal, include it
      if (nodeIds.has(edge.source_node_id) || nodeIds.has(edge.target_node_id)) {
        result.push(edge);
      }
    }
    return result;
  }
}
