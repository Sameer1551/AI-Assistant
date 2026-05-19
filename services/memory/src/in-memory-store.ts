/**
 * @module in-memory-memory-store
 * In-memory implementation of IMemoryStore for development and testing.
 *
 * Production deployments should replace this with a vector database
 * (e.g., pgvector, Weaviate, Pinecone) while preserving the interface contract.
 */

import type { MemoryRecord, MemoryLayer } from '@may/types';
import type { IMemoryStore } from './interfaces/index.js';

export class InMemoryMemoryStore implements IMemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly accessCounts = new Map<string, number>();

  async save(record: MemoryRecord): Promise<void> {
    this.records.set(record.record_id, record);
  }

  async findById(recordId: string, tenantId: string): Promise<MemoryRecord | null> {
    const record = this.records.get(recordId);
    if (!record || record.tenant_id !== tenantId) return null;
    return record;
  }

  async findByTenantAndPrincipal(
    tenantId: string,
    principalId: string,
    layer?: MemoryLayer,
  ): Promise<readonly MemoryRecord[]> {
    return Array.from(this.records.values()).filter(
      (r) =>
        r.tenant_id === tenantId &&
        r.principal_id === principalId &&
        (layer === undefined || r.layer === layer),
    );
  }

  async delete(recordId: string, tenantId: string): Promise<boolean> {
    const record = this.records.get(recordId);
    if (!record || record.tenant_id !== tenantId) return false;
    this.records.delete(recordId);
    this.accessCounts.delete(recordId);
    return true;
  }

  async findExpired(tenantId: string, now: Date): Promise<readonly MemoryRecord[]> {
    const nowIso = now.toISOString();
    return Array.from(this.records.values()).filter(
      (r) => r.tenant_id === tenantId && r.expires_at !== undefined && r.expires_at <= nowIso,
    );
  }

  async incrementAccessCount(recordId: string): Promise<void> {
    this.accessCounts.set(recordId, (this.accessCounts.get(recordId) ?? 0) + 1);
  }

  async getAccessCount(recordId: string): Promise<number> {
    return this.accessCounts.get(recordId) ?? 0;
  }
}
