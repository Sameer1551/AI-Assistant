/**
 * Workflow service interfaces.
 */

import type { WorkflowDefinition, WorkflowStatus, WorkflowStep } from '@may/types';

export interface CreateWorkflowRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly Omit<WorkflowStep, 'status' | 'result' | 'error' | 'retry_count'>[];
  readonly timeout_seconds?: number;
  readonly concurrency_group?: string;
  readonly retry_policy?: import('@may/types').RetryPolicy;
  readonly resource_budget?: import('@may/types').ResourceBudget;
}

export interface CreateWorkflowResponse {
  readonly workflow_id: string;
  readonly status: WorkflowStatus;
  readonly created_at: string;
}

export interface GetWorkflowStatusResponse {
  readonly workflow: WorkflowDefinition;
}

export interface WorkflowConcurrencyConfig {
  readonly max_concurrent_per_tenant: number;  // default 5
}

export interface IWorkflowStore {
  save(workflow: WorkflowDefinition): Promise<void>;
  findById(workflowId: string, tenantId: string): Promise<WorkflowDefinition | null>;
  findInProgress(tenantId: string): Promise<readonly WorkflowDefinition[]>;
  countActive(tenantId: string): Promise<number>;
  update(workflow: WorkflowDefinition): Promise<void>;
}

export interface IWorkflowAuditEmitter {
  emit(event: {
    event_type: string;
    tenant_id: string;
    principal_id: string;
    workflow_id: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

export interface IWorkflowIdGenerator {
  uuid(): string;
}

export interface IWorkflowClock {
  nowISO(): string;
}

export interface IWorkflowService {
  createWorkflow(request: CreateWorkflowRequest): Promise<CreateWorkflowResponse>;
  getWorkflowStatus(workflowId: string, tenantId: string): Promise<GetWorkflowStatusResponse>;
  pauseWorkflow(workflowId: string, tenantId: string): Promise<void>;
  resumeWorkflow(workflowId: string, tenantId: string): Promise<void>;
  cancelWorkflow(workflowId: string, tenantId: string): Promise<void>;
  validateDependencyGraph(steps: readonly { step_id: string; dependencies: readonly string[] }[]): boolean;
  resumeInProgressWorkflows(tenantId: string): Promise<number>;
}

export const DEFAULT_WORKFLOW_TIMEOUT_SECONDS = 3600;
export const DEFAULT_MAX_CONCURRENT_PER_TENANT = 5;
