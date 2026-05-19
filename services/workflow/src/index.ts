/**
 * @may/workflow — Workflow Service entry point
 */

export { WorkflowService } from './workflow-service.js';
export { InMemoryWorkflowStore } from './in-memory-workflow-store.js';
export { isValidDAG } from './dependency-graph.js';
export { computeBackoffDelay } from './backoff.js';
export type {
  IWorkflowService,
  IWorkflowStore,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowStatusResponse,
} from './interfaces/index.js';
