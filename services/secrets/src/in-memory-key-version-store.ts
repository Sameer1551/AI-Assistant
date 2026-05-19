/**
 * InMemoryKeyVersionStore - In-memory key version store for testing.
 *
 * ⚠️ NON-PRODUCTION: This implementation is for testing and development only.
 * Production deployments MUST use a durable, encrypted database.
 *
 * Tracks key versions, rotation dates, and revocation status in memory.
 * Implements the IKeyStore interface for dependency injection.
 *
 * @see Requirement 19.3 - Rotation tracking
 * @see Requirement 19.4 - Version retention (only 2 most recent)
 */

import type { IKeyStore } from './interfaces/index.js';
import type { KeyMetadata, RotationPolicy } from './types/index.js';

/**
 * In-memory implementation of IKeyStore for testing purposes.
 *
 * ⚠️ WARNING: This is NOT suitable for production use.
 * Data is lost on process restart. Production deployments require
 * a durable, encrypted database with proper access controls.
 *
 * Features:
 * - Full IKeyStore interface implementation
 * - Tenant-scoped key isolation
 * - Version tracking with status management
 * - Rotation policy checking
 *
 * @example
 * ```typescript
 * const store = new InMemoryKeyVersionStore();
 * await store.save(keyMetadata);
 * const key = await store.get('key-001', 'tenant-001');
 * ```
 */
export class InMemoryKeyVersionStore implements IKeyStore {
  /**
   * Internal storage: Map<"tenantId:keyId", KeyMetadata[]>
   * Versions are kept sorted by version number descending.
   */
  private readonly store: Map<string, KeyMetadata[]> = new Map();

  /**
   * Stores key metadata. If a version with the same number already exists,
   * it will be replaced.
   *
   * @param metadata - The key metadata to store
   */
  async save(metadata: KeyMetadata): Promise<void> {
    const compositeKey = this.compositeKey(metadata.tenant_id, metadata.key_id);
    const versions = this.store.get(compositeKey) ?? [];

    // Replace if same version exists, otherwise add
    const existingIdx = versions.findIndex((v) => v.version === metadata.version);
    if (existingIdx >= 0) {
      versions[existingIdx] = metadata;
    } else {
      versions.push(metadata);
    }

    // Keep sorted by version descending
    versions.sort((a, b) => b.version - a.version);
    this.store.set(compositeKey, versions);
  }

  /**
   * Retrieves key metadata by key ID and optional version.
   * If version is not specified, returns the latest active version.
   * If no active version exists, returns the latest version regardless of status.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @param version - Optional specific version
   * @returns The key metadata, or null if not found
   */
  async get(keyId: string, tenantId: string, version?: number): Promise<KeyMetadata | null> {
    const compositeKey = this.compositeKey(tenantId, keyId);
    const versions = this.store.get(compositeKey) ?? [];

    if (versions.length === 0) {
      return null;
    }

    if (version !== undefined) {
      return versions.find((v) => v.version === version) ?? null;
    }

    // Return latest active version, or latest overall if none active
    const active = versions.find((v) => v.status === 'active');
    return active ?? versions[0] ?? null;
  }

  /**
   * Retrieves all versions of a key for a tenant, ordered by version descending.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @returns All versions of the key
   */
  async getAllVersions(keyId: string, tenantId: string): Promise<KeyMetadata[]> {
    const compositeKey = this.compositeKey(tenantId, keyId);
    return [...(this.store.get(compositeKey) ?? [])];
  }

  /**
   * Updates the status of a specific key version.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @param version - The version to update
   * @param status - The new status
   */
  async updateStatus(
    keyId: string,
    tenantId: string,
    version: number,
    status: KeyMetadata['status'],
  ): Promise<void> {
    const compositeKey = this.compositeKey(tenantId, keyId);
    const versions = this.store.get(compositeKey) ?? [];
    const idx = versions.findIndex((v) => v.version === version);

    if (idx >= 0) {
      versions[idx] = { ...versions[idx]!, status };
    }
  }

  /**
   * Deletes key metadata for a specific version.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @param version - The version to delete
   */
  async delete(keyId: string, tenantId: string, version: number): Promise<void> {
    const compositeKey = this.compositeKey(tenantId, keyId);
    const versions = this.store.get(compositeKey) ?? [];
    const filtered = versions.filter((v) => v.version !== version);
    this.store.set(compositeKey, filtered);
  }

  /**
   * Lists all keys for a tenant that need rotation based on policy.
   * Returns active keys whose age exceeds the policy maximum.
   *
   * @param tenantId - The tenant identifier
   * @param policy - The rotation policy to check against
   * @param now - Current timestamp for age calculation
   * @returns Keys that are due for rotation
   */
  async getKeysNeedingRotation(
    tenantId: string,
    policy: RotationPolicy,
    now: Date,
  ): Promise<KeyMetadata[]> {
    const results: KeyMetadata[] = [];

    for (const [key, versions] of this.store.entries()) {
      if (!key.startsWith(`${tenantId}:`)) {
        continue;
      }

      const active = versions.find((v) => v.status === 'active');
      if (!active) {
        continue;
      }

      const rotatedAt = new Date(active.rotated_at);
      const ageMs = now.getTime() - rotatedAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      const maxAgeDays = active.key_type === 'symmetric'
        ? policy.symmetric_max_age_days
        : policy.asymmetric_max_age_days;

      if (ageDays >= maxAgeDays) {
        results.push(active);
      }
    }

    return results;
  }

  // ─── Test Helpers ────────────────────────────────────────────────────────

  /**
   * Seeds the store with key metadata (convenience for tests).
   *
   * @param metadata - The key metadata to seed
   */
  seed(metadata: KeyMetadata): void {
    const compositeKey = this.compositeKey(metadata.tenant_id, metadata.key_id);
    const versions = this.store.get(compositeKey) ?? [];
    versions.push(metadata);
    versions.sort((a, b) => b.version - a.version);
    this.store.set(compositeKey, versions);
  }

  /** Returns the total number of key entries (across all versions). */
  get totalVersionCount(): number {
    let count = 0;
    for (const versions of this.store.values()) {
      count += versions.length;
    }
    return count;
  }

  /** Returns the number of distinct keys (not versions). */
  get keyCount(): number {
    return this.store.size;
  }

  /** Clears all stored data (for test reset). */
  reset(): void {
    this.store.clear();
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private compositeKey(tenantId: string, keyId: string): string {
    return `${tenantId}:${keyId}`;
  }
}
