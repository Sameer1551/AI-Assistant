/**
 * In-memory implementation of IDSARStore for testing.
 *
 * Stores DSAR requests in memory with tenant isolation.
 * Not suitable for production use.
 */

import type { DSARRequest } from '@may/types';
import type { IDSARStore } from './interfaces/index.js';

export class InMemoryDSARStore implements IDSARStore {
  /** Map of tenant_id → dsar_id → DSARRequest */
  private readonly store: Map<string, Map<string, DSARRequest>> = new Map();

  async save(request: DSARRequest): Promise<void> {
    const tenantStore = this.getOrCreateTenantStore(request.tenant_id);
    tenantStore.set(request.dsar_id, request);
  }

  async findById(dsarId: string, tenantId: string): Promise<DSARRequest | null> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return null;
    return tenantStore.get(dsarId) ?? null;
  }

  async update(request: DSARRequest): Promise<void> {
    const tenantStore = this.getOrCreateTenantStore(request.tenant_id);
    if (!tenantStore.has(request.dsar_id)) {
      throw new Error(`DSAR ${request.dsar_id} not found in tenant ${request.tenant_id}`);
    }
    tenantStore.set(request.dsar_id, request);
  }

  async findByDataSubject(
    dataSubjectId: string,
    tenantId: string,
  ): Promise<readonly DSARRequest[]> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return [];

    return Array.from(tenantStore.values()).filter(
      (r) => r.data_subject_id === dataSubjectId,
    );
  }

  /** Clear all stored data (useful for test cleanup) */
  clear(): void {
    this.store.clear();
  }

  private getOrCreateTenantStore(tenantId: string): Map<string, DSARRequest> {
    let tenantStore = this.store.get(tenantId);
    if (!tenantStore) {
      tenantStore = new Map();
      this.store.set(tenantId, tenantStore);
    }
    return tenantStore;
  }
}
