/**
 * @module in-memory-workflow-store
 * In-memory workflow persistence store for development and testing.
 */

import type { WorkflowDefinition } from '@may/types';
import type { IWorkflowStore } from './interfaces/index.js';

export class InMemoryWorkflowStore implements IWorkflowStore {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  async save(workflow: WorkflowDefinition): Promise<void> {
    this.workflows.set(workflow.workflow_id, workflow);
  }

  async findById(workflowId: string, tenantId: string): Promise<WorkflowDefinition | null> {
    const wf = this.workflows.get(workflowId);
    if (!wf || wf.tenant_id !== tenantId) return null;
    return wf;
  }

  async findInProgress(tenantId: string): Promise<readonly WorkflowDefinition[]> {
    return Array.from(this.workflows.values()).filter(
      (wf) => wf.tenant_id === tenantId && (wf.status === 'RUNNING' || wf.status === 'PAUSED'),
    );
  }

  async countActive(tenantId: string): Promise<number> {
    return Array.from(this.workflows.values()).filter(
      (wf) => wf.tenant_id === tenantId && (wf.status === 'RUNNING' || wf.status === 'PAUSED' || wf.status === 'CREATED'),
    ).length;
  }

  async update(workflow: WorkflowDefinition): Promise<void> {
    this.workflows.set(workflow.workflow_id, workflow);
  }
}
