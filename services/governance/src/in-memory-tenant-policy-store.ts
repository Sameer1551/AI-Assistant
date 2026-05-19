/**
 * In-memory implementation of the tenant policy store.
 *
 * Used for testing and development. Production implementations
 * would be backed by a database or configuration service.
 */

import type { ITenantPolicyStore, TenantRedactionPolicy } from './interfaces/index.js';

/**
 * In-memory tenant policy store.
 *
 * Stores tenant redaction policies in a Map for fast lookup.
 * Not suitable for production use — no persistence or replication.
 */
export class InMemoryTenantPolicyStore implements ITenantPolicyStore {
  private readonly policies: Map<string, TenantRedactionPolicy> = new Map();

  /**
   * Retrieves the redaction policy for a tenant.
   *
   * @param tenantId - The tenant identifier
   * @returns The tenant's redaction policy, or null if not configured
   */
  async getRedactionPolicy(tenantId: string): Promise<TenantRedactionPolicy | null> {
    return this.policies.get(tenantId) ?? null;
  }

  /**
   * Sets or updates the redaction policy for a tenant.
   *
   * @param tenantId - The tenant identifier
   * @param policy - The policy to set
   */
  async setRedactionPolicy(tenantId: string, policy: TenantRedactionPolicy): Promise<void> {
    this.policies.set(tenantId, policy);
  }

  /**
   * Removes the redaction policy for a tenant.
   * Useful for testing cleanup.
   *
   * @param tenantId - The tenant identifier
   */
  async removeRedactionPolicy(tenantId: string): Promise<void> {
    this.policies.delete(tenantId);
  }

  /**
   * Clears all stored policies.
   * Useful for testing cleanup.
   */
  async clear(): Promise<void> {
    this.policies.clear();
  }
}
