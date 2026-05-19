/**
 * In-memory implementation of ITenantTaxonomyStore.
 *
 * Used for testing and development. Production implementations would
 * back this with a database or configuration service.
 */

import type { DataClassification } from '@may/types';
import type {
  ITenantTaxonomyStore,
  RetentionRule,
} from './interfaces/classification-service.js';

/**
 * Default classification taxonomy that all tenants support.
 */
const DEFAULT_TAXONOMY: readonly DataClassification[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'regulated_pii',
  'regulated_health',
  'regulated_financial',
];

/**
 * Tenant taxonomy configuration stored in memory.
 */
interface TenantTaxonomyConfig {
  readonly classifications: readonly DataClassification[];
  readonly retentionRules: readonly RetentionRule[];
  readonly residencyRegion: string;
}

/**
 * In-memory tenant taxonomy store.
 * Stores tenant-specific classification taxonomies, retention rules,
 * and residency region configurations.
 */
export class InMemoryTenantTaxonomyStore implements ITenantTaxonomyStore {
  private readonly configs: Map<string, TenantTaxonomyConfig> = new Map();

  /**
   * Configures a tenant's taxonomy, retention rules, and residency region.
   */
  configure(tenantId: string, config: TenantTaxonomyConfig): void {
    this.configs.set(tenantId, config);
  }

  /**
   * Returns the allowed classifications for a tenant.
   * Falls back to the default taxonomy if no custom config exists.
   */
  async getAllowedClassifications(tenantId: string): Promise<readonly DataClassification[]> {
    const config = this.configs.get(tenantId);
    return config?.classifications ?? DEFAULT_TAXONOMY;
  }

  /**
   * Returns the retention rules configured for a tenant.
   * Returns an empty array if no rules are configured.
   */
  async getRetentionRules(tenantId: string): Promise<readonly RetentionRule[]> {
    const config = this.configs.get(tenantId);
    return config?.retentionRules ?? [];
  }

  /**
   * Returns the configured residency region for a tenant.
   * Defaults to 'us-east-1' if not configured.
   */
  async getResidencyRegion(tenantId: string): Promise<string> {
    const config = this.configs.get(tenantId);
    return config?.residencyRegion ?? 'us-east-1';
  }
}
