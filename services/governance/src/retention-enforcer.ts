/**
 * Retention enforcer implementation.
 *
 * Evaluates records against tenant-configured retention rules and marks
 * expired records for irreversible deletion or cryptographic shredding.
 * Deletion must complete within 24 hours of expiry.
 *
 * @see Requirement 25.2 - Retention rules per classification and per component
 * @see Requirement 25.3 - Irreversible deletion/shredding within 24h of expiry
 */

import type { DataClassification } from '@may/types';
import type {
  IRetentionEnforcer,
  ITenantTaxonomyStore,
  RetentionRecord,
  RetentionRule,
  RetentionEnforcementResult,
  ExpiredRecord,
} from './interfaces/classification-service.js';

/** 24 hours in milliseconds — the maximum time allowed for deletion after expiry. */
const DELETION_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * Classifications that require cryptographic shredding rather than simple deletion.
 * These are regulated data types where deletion must be provably irreversible.
 */
const SHRED_CLASSIFICATIONS: ReadonlySet<DataClassification> = new Set<DataClassification>([
  'regulated_pii',
  'regulated_health',
  'regulated_financial',
  'restricted',
]);

/**
 * RetentionEnforcer evaluates records against retention rules and marks
 * expired records for deletion or cryptographic shredding.
 *
 * Uses DI for the tenant taxonomy store to retrieve retention rules.
 */
export class RetentionEnforcer implements IRetentionEnforcer {
  constructor(private readonly taxonomyStore: ITenantTaxonomyStore) {}

  /**
   * Evaluates all provided records against the tenant's retention rules.
   *
   * For each record:
   * 1. Finds the applicable retention rule (component-specific first, then classification-level)
   * 2. Computes the expiry time based on creation date + retention duration
   * 3. If the record has expired, marks it for deletion/shredding with a 24h deadline
   *
   * @param tenantId - The tenant whose records to evaluate
   * @param records - The records to evaluate
   * @param now - The current timestamp (for testability), defaults to Date.now()
   * @returns Enforcement result with expired records
   */
  async enforce(
    tenantId: string,
    records: readonly RetentionRecord[],
    now?: Date,
  ): Promise<RetentionEnforcementResult> {
    const currentTime = now ?? new Date();
    const retentionRules = await this.taxonomyStore.getRetentionRules(tenantId);

    const expiredRecords: ExpiredRecord[] = [];

    for (const record of records) {
      if (record.tenant_id !== tenantId) {
        continue; // Skip records not belonging to this tenant
      }

      const rule = this.findApplicableRule(record, retentionRules);
      if (!rule) {
        continue; // No retention rule found — record is not subject to expiry
      }

      const createdAt = new Date(record.created_at);
      const expiresAt = new Date(createdAt.getTime() + rule.retention_days * 24 * 60 * 60 * 1000);

      if (currentTime >= expiresAt) {
        const deletionMethod = SHRED_CLASSIFICATIONS.has(record.classification)
          ? 'cryptographic_shred'
          : 'irreversible_delete';

        const deletionDeadline = new Date(currentTime.getTime() + DELETION_DEADLINE_MS);

        expiredRecords.push({
          record_id: record.record_id,
          classification: record.classification,
          component: record.component,
          expired_at: expiresAt.toISOString(),
          deletion_method: deletionMethod,
          deletion_deadline: deletionDeadline.toISOString(),
        });
      }
    }

    return {
      tenant_id: tenantId,
      expired_records: expiredRecords,
      enforced_at: currentTime.toISOString(),
    };
  }

  /**
   * Finds the most specific retention rule for a record.
   *
   * Priority:
   * 1. Component-specific rule matching both classification and component
   * 2. Classification-level rule (no component scope)
   *
   * @returns The applicable rule, or undefined if none found
   */
  private findApplicableRule(
    record: RetentionRecord,
    rules: readonly RetentionRule[],
  ): RetentionRule | undefined {
    // First, look for a component-specific rule
    const componentRule = rules.find(
      (r) => r.classification === record.classification && r.component === record.component,
    );
    if (componentRule) {
      return componentRule;
    }

    // Fall back to classification-level rule (no component scope)
    return rules.find(
      (r) => r.classification === record.classification && !r.component,
    );
  }
}
