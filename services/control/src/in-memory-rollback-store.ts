/**
 * In-memory implementation of the rollback store.
 *
 * Suitable for testing and single-instance deployments.
 * Production deployments should use a durable store implementation.
 *
 * @module in-memory-rollback-store
 */

import type { RollbackDescriptor } from '@may/types';
import type { IRollbackStore } from './interfaces/index.js';

/**
 * In-memory rollback store implementation.
 * Stores descriptors in a Map keyed by descriptor_id.
 */
export class InMemoryRollbackStore implements IRollbackStore {
  private readonly descriptors = new Map<string, RollbackDescriptor>();
  private readonly actionIndex = new Map<string, string>(); // action_id -> descriptor_id

  async save(descriptor: RollbackDescriptor): Promise<void> {
    this.descriptors.set(descriptor.descriptor_id, descriptor);
    this.actionIndex.set(
      this.makeActionKey(descriptor.action_id, descriptor.tenant_id),
      descriptor.descriptor_id,
    );
  }

  async getByActionId(actionId: string, tenantId: string): Promise<RollbackDescriptor | undefined> {
    const key = this.makeActionKey(actionId, tenantId);
    const descriptorId = this.actionIndex.get(key);
    if (!descriptorId) {
      return undefined;
    }
    const descriptor = this.descriptors.get(descriptorId);
    if (!descriptor) {
      return undefined;
    }
    return descriptor;
  }

  async getByDescriptorId(
    descriptorId: string,
    tenantId: string,
  ): Promise<RollbackDescriptor | undefined> {
    const descriptor = this.descriptors.get(descriptorId);
    if (!descriptor) {
      return undefined;
    }
    // Enforce tenant isolation
    if (descriptor.tenant_id !== tenantId) {
      return undefined;
    }
    return descriptor;
  }

  async markExecuted(descriptorId: string, tenantId: string): Promise<void> {
    const descriptor = this.descriptors.get(descriptorId);
    if (!descriptor || descriptor.tenant_id !== tenantId) {
      return;
    }
    this.descriptors.set(descriptorId, { ...descriptor, executed: true });
  }

  async removeExpired(): Promise<number> {
    const now = new Date();
    let removed = 0;
    for (const [id, descriptor] of this.descriptors) {
      if (new Date(descriptor.expires_at) < now) {
        this.descriptors.delete(id);
        this.actionIndex.delete(
          this.makeActionKey(descriptor.action_id, descriptor.tenant_id),
        );
        removed++;
      }
    }
    return removed;
  }

  /** Get the total number of stored descriptors (for testing) */
  get size(): number {
    return this.descriptors.size;
  }

  private makeActionKey(actionId: string, tenantId: string): string {
    return `${tenantId}:${actionId}`;
  }
}
