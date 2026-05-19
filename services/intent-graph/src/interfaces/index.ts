import type { IntentNode, IntentEdge } from '@may/types';

export interface IIntentIdGenerator {
  uuid(): string;
}

export interface IIntentClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface IntentGraphStore {
  createNode(node: IntentNode): Promise<void>;
  updateNode(node: IntentNode): Promise<void>;
  deleteNode(nodeId: string): Promise<void>;
  getNode(nodeId: string): Promise<IntentNode | undefined>;
  getNodesForPrincipal(tenantId: string, principalId: string): Promise<IntentNode[]>;
  
  createEdge(edge: IntentEdge): Promise<void>;
  deleteEdge(edgeId: string): Promise<void>;
  getEdgesForNode(nodeId: string): Promise<IntentEdge[]>;
  getEdgesForPrincipal(tenantId: string, principalId: string): Promise<IntentEdge[]>;
}
