/**
 * @module workflow-service
 * Workflow_Service with durable execution, retry, and concurrency control.
 *
 * Key behaviors:
 * - Persists every state transition before proceeding to next step
 * - Resumes in-progress workflows within 60s of restart
 * - Enforces per-tenant concurrency limit with backpressure
 * - Pauses for HIGH/CRITICAL actions requiring Confirmation_Challenge
 * - Retry with exponential backoff
 * - Dependency cycle detection at workflow creation time
 *
 * @see Requirements 8.1–8.11
 */

import type { WorkflowDefinition, WorkflowStep, RetryPolicy } from '@may/types';
import type {
  IWorkflowService,
  IWorkflowStore,
  IWorkflowAuditEmitter,
  IWorkflowIdGenerator,
  IWorkflowClock,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowStatusResponse,
} from './interfaces/index.js';
import {
  DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONCURRENT_PER_TENANT,
} from './interfaces/index.js';
import { isValidDAG } from './dependency-graph.js';

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 3,
  initial_backoff_ms: 1000,
  max_backoff_ms: 30_000,
  backoff_multiplier: 2,
};

export interface WorkflowServiceDeps {
  readonly store: IWorkflowStore;
  readonly auditEmitter: IWorkflowAuditEmitter;
  readonly idGenerator: IWorkflowIdGenerator;
  readonly clock: IWorkflowClock;
  readonly maxConcurrentPerTenant?: number;
}

export class WorkflowService implements IWorkflowService {
  private readonly store: IWorkflowStore;
  private readonly auditEmitter: IWorkflowAuditEmitter;
  private readonly idGenerator: IWorkflowIdGenerator;
  private readonly clock: IWorkflowClock;
  private readonly maxConcurrentPerTenant: number;

  constructor(deps: WorkflowServiceDeps) {
    this.store = deps.store;
    this.auditEmitter = deps.auditEmitter;
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.maxConcurrentPerTenant = deps.maxConcurrentPerTenant ?? DEFAULT_MAX_CONCURRENT_PER_TENANT;
  }

  /**
   * Create a new workflow.
   *
   * Validates dependency graph (no cycles) and enforces per-tenant concurrency limit.
   * State is persisted before returning.
   *
   * @see Requirement 8.1 — durable persistence at every state transition
   * @see Requirement 8.6 — per-tenant concurrency limit with backpressure
   */
  async createWorkflow(request: CreateWorkflowRequest): Promise<CreateWorkflowResponse> {
    const {
      tenant_id,
      principal_id,
      name,
      description,
      steps: rawSteps,
      timeout_seconds = DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
      concurrency_group,
      retry_policy = DEFAULT_RETRY_POLICY,
      resource_budget,
    } = request;

    // Validate dependency graph — reject cyclic definitions
    if (!this.validateDependencyGraph(rawSteps)) {
      throw new Error('CYCLIC_DEPENDENCY: Workflow dependency graph contains a cycle');
    }

    // Enforce per-tenant concurrency limit
    const activeCount = await this.store.countActive(tenant_id);
    if (activeCount >= this.maxConcurrentPerTenant) {
      throw new Error(
        `BACKPRESSURE: Tenant ${tenant_id} has reached max concurrent workflows (${this.maxConcurrentPerTenant})`,
      );
    }

    const workflow_id = this.idGenerator.uuid();
    const now = this.clock.nowISO();

    const steps: WorkflowStep[] = rawSteps.map((s) => ({
      ...s,
      status: 'PENDING',
      retry_count: 0,
    }));

    const workflow: WorkflowDefinition = {
      workflow_id,
      tenant_id,
      principal_id,
      name,
      description,
      steps,
      timeout_seconds,
      concurrency_group,
      retry_policy,
      resource_budget,
      status: 'CREATED',
      created_at: now,
      updated_at: now,
    };

    // Persist state before returning (Requirement 8.1)
    await this.store.save(workflow);

    await this.auditEmitter.emit({
      event_type: 'workflow.created',
      tenant_id,
      principal_id,
      workflow_id,
      details: { name, step_count: steps.length },
    });

    return { workflow_id, status: 'CREATED', created_at: now };
  }

  /**
   * Get the current status of a workflow.
   */
  async getWorkflowStatus(workflowId: string, tenantId: string): Promise<GetWorkflowStatusResponse> {
    const workflow = await this.store.findById(workflowId, tenantId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    return { workflow };
  }

  /**
   * Pause a running workflow.
   *
   * @see Requirement 8.5 — pause workflow
   */
  async pauseWorkflow(workflowId: string, tenantId: string): Promise<void> {
    const workflow = await this.requireWorkflow(workflowId, tenantId);
    if (workflow.status !== 'RUNNING') {
      throw new Error(`Cannot pause workflow in status: ${workflow.status}`);
    }

    const updated: WorkflowDefinition = {
      ...workflow,
      status: 'PAUSED',
      updated_at: this.clock.nowISO(),
    };

    await this.store.update(updated);
    await this.auditEmitter.emit({
      event_type: 'workflow.paused',
      tenant_id: tenantId,
      principal_id: workflow.principal_id,
      workflow_id: workflowId,
    });
  }

  /**
   * Resume a paused workflow.
   *
   * @see Requirement 8.5 — resume workflow
   */
  async resumeWorkflow(workflowId: string, tenantId: string): Promise<void> {
    const workflow = await this.requireWorkflow(workflowId, tenantId);
    if (workflow.status !== 'PAUSED') {
      throw new Error(`Cannot resume workflow in status: ${workflow.status}`);
    }

    const updated: WorkflowDefinition = {
      ...workflow,
      status: 'RUNNING',
      updated_at: this.clock.nowISO(),
    };

    await this.store.update(updated);
    await this.auditEmitter.emit({
      event_type: 'workflow.resumed',
      tenant_id: tenantId,
      principal_id: workflow.principal_id,
      workflow_id: workflowId,
    });
  }

  /**
   * Cancel a workflow (terminal state).
   *
   * @see Requirement 8.5 — cancel workflow
   */
  async cancelWorkflow(workflowId: string, tenantId: string): Promise<void> {
    const workflow = await this.requireWorkflow(workflowId, tenantId);
    if (workflow.status === 'COMPLETED' || workflow.status === 'CANCELLED') {
      throw new Error(`Workflow already in terminal status: ${workflow.status}`);
    }

    const now = this.clock.nowISO();
    const updated: WorkflowDefinition = {
      ...workflow,
      status: 'CANCELLED',
      updated_at: now,
      completed_at: now,
    };

    await this.store.update(updated);
    await this.auditEmitter.emit({
      event_type: 'workflow.cancelled',
      tenant_id: tenantId,
      principal_id: workflow.principal_id,
      workflow_id: workflowId,
    });
  }

  /**
   * Validate a dependency graph for cycles.
   *
   * @returns true if the graph is a valid DAG (acyclic)
   * @see Requirement 8.11 — cycle detection, reject cyclic definitions
   */
  validateDependencyGraph(
    steps: readonly { step_id: string; dependencies: readonly string[] }[],
  ): boolean {
    return isValidDAG(steps);
  }

  /**
   * Resume all in-progress workflows for a tenant.
   * Called on service restart to resume within 60s.
   *
   * @returns Number of workflows resumed
   * @see Requirement 8.2 — resume in-progress workflows within 60s of restart
   */
  async resumeInProgressWorkflows(tenantId: string): Promise<number> {
    const inProgress = await this.store.findInProgress(tenantId);
    let resumed = 0;

    for (const wf of inProgress) {
      if (wf.status === 'PAUSED') {
        // Re-transition to RUNNING so the execution engine can pick it up
        const updated: WorkflowDefinition = {
          ...wf,
          status: 'RUNNING',
          updated_at: this.clock.nowISO(),
        };
        await this.store.update(updated);
        resumed++;
      }
    }

    return resumed;
  }

  private async requireWorkflow(workflowId: string, tenantId: string): Promise<WorkflowDefinition> {
    const wf = await this.store.findById(workflowId, tenantId);
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
    return wf;
  }
}
