/**
 * Classification service interface.
 *
 * Defines the contract for data classification, retention enforcement,
 * and residency validation within the Governance_Service.
 *
 * @see Requirement 25.1 - Tenant-configurable data classification taxonomy
 * @see Requirement 25.2 - Retention rules per classification and per component
 * @see Requirement 25.3 - Irreversible deletion/shredding within 24h of expiry
 * @see Requirement 25.4 - Data_Residency_Region enforcement
 * @see Requirement 25.5 - Region migration planning
 */

import type { DataClassification, RequestContext } from '@may/types';

// ─── Classification Types ────────────────────────────────────────────────────

/**
 * Request to classify a data record.
 */
export interface ClassifyRequest {
  /** Unique identifier of the record to classify */
  readonly record_id: string;
  /** Tenant boundary identifier */
  readonly tenant_id: string;
  /** Content or metadata used for classification */
  readonly content: string;
  /** Optional hint about the data source/component */
  readonly source_component?: string;
  /** Optional explicit classification override (must be in tenant taxonomy) */
  readonly explicit_classification?: DataClassification;
}

/**
 * Result of a classification operation.
 */
export interface ClassifyResult {
  /** The record that was classified */
  readonly record_id: string;
  /** The assigned classification */
  readonly classification: DataClassification;
  /** Confidence of the classification [0.0, 1.0] */
  readonly confidence: number;
  /** Whether the classification was explicitly set or inferred */
  readonly method: 'explicit' | 'inferred';
  /** ISO 8601 timestamp of classification */
  readonly classified_at: string;
}

// ─── Retention Types ─────────────────────────────────────────────────────────

/**
 * A retention rule defining how long data of a given classification
 * should be retained, optionally scoped to a specific component.
 */
export interface RetentionRule {
  /** The data classification this rule applies to */
  readonly classification: DataClassification;
  /** Retention duration in days */
  readonly retention_days: number;
  /** Optional component scope (if absent, applies globally for this classification) */
  readonly component?: string;
}

/**
 * A record tracked for retention enforcement.
 */
export interface RetentionRecord {
  /** Unique identifier of the record */
  readonly record_id: string;
  /** Tenant boundary identifier */
  readonly tenant_id: string;
  /** The data classification of this record */
  readonly classification: DataClassification;
  /** The component that owns this record */
  readonly component: string;
  /** ISO 8601 timestamp when the record was created */
  readonly created_at: string;
  /** ISO 8601 timestamp when the record expires (computed from retention rule) */
  readonly expires_at: string;
}

/**
 * Result of retention enforcement evaluation.
 */
export interface RetentionEnforcementResult {
  /** Tenant whose records were evaluated */
  readonly tenant_id: string;
  /** Records marked for deletion/shredding */
  readonly expired_records: readonly ExpiredRecord[];
  /** ISO 8601 timestamp of the enforcement run */
  readonly enforced_at: string;
}

/**
 * A record that has been marked for deletion or cryptographic shredding.
 */
export interface ExpiredRecord {
  /** Unique identifier of the expired record */
  readonly record_id: string;
  /** The classification of the expired record */
  readonly classification: DataClassification;
  /** The component that owns the record */
  readonly component: string;
  /** ISO 8601 timestamp when the record expired */
  readonly expired_at: string;
  /** The deletion method to use */
  readonly deletion_method: 'irreversible_delete' | 'cryptographic_shred';
  /** Deadline by which deletion must complete (within 24h of expiry) */
  readonly deletion_deadline: string;
}

// ─── Residency Types ─────────────────────────────────────────────────────────

/**
 * Request to validate a data operation against residency constraints.
 */
export interface ResidencyValidationRequest {
  /** Tenant boundary identifier */
  readonly tenant_id: string;
  /** The region where the operation would occur */
  readonly target_region: string;
  /** Type of operation being validated */
  readonly operation_type: 'persistence' | 'processing';
  /** Description of the operation for audit purposes */
  readonly operation_description?: string;
}

/**
 * Result of a residency validation.
 */
export interface ResidencyValidationResult {
  /** Whether the operation is allowed in the target region */
  readonly allowed: boolean;
  /** The tenant's configured residency region */
  readonly configured_region: string;
  /** The target region that was validated */
  readonly target_region: string;
  /** Reason for denial (if not allowed) */
  readonly denial_reason?: string;
}

/**
 * A migration plan produced when a tenant changes residency region.
 */
export interface ResidencyMigrationPlan {
  /** Tenant boundary identifier */
  readonly tenant_id: string;
  /** The current (source) region */
  readonly source_region: string;
  /** The target (destination) region */
  readonly target_region: string;
  /** Steps required for migration */
  readonly steps: readonly MigrationStep[];
  /** Whether migration is complete and verified */
  readonly verified: boolean;
  /** ISO 8601 timestamp when the plan was created */
  readonly created_at: string;
}

/**
 * A single step in a residency migration plan.
 */
export interface MigrationStep {
  /** Step identifier */
  readonly step_id: string;
  /** Description of what this step does */
  readonly description: string;
  /** The component affected */
  readonly component: string;
  /** Status of this step */
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

// ─── Service Interfaces ──────────────────────────────────────────────────────

/**
 * Tenant taxonomy configuration store.
 * Provides access to tenant-specific classification taxonomies and retention rules.
 */
export interface ITenantTaxonomyStore {
  /**
   * Returns the allowed classifications for a tenant.
   * Must include at minimum the default taxonomy.
   */
  getAllowedClassifications(tenantId: string): Promise<readonly DataClassification[]>;

  /**
   * Returns the retention rules configured for a tenant.
   */
  getRetentionRules(tenantId: string): Promise<readonly RetentionRule[]>;

  /**
   * Returns the configured residency region for a tenant.
   */
  getResidencyRegion(tenantId: string): Promise<string>;
}

/**
 * Classification service interface.
 *
 * Classifies data records according to the tenant's configured taxonomy.
 *
 * @see Requirement 25.1 - Tenant-configurable data classification taxonomy
 */
export interface IClassificationService {
  /**
   * Classifies a data record using the tenant's taxonomy.
   *
   * If an explicit classification is provided and is valid within the tenant's
   * taxonomy, it is used directly. Otherwise, classification is inferred from
   * the content.
   *
   * @param request - The classification request
   * @param ctx - The authenticated request context
   * @returns The classification result
   * @throws If the explicit classification is not in the tenant's taxonomy
   */
  classify(request: ClassifyRequest, ctx: RequestContext): Promise<ClassifyResult>;
}

/**
 * Retention enforcer interface.
 *
 * Evaluates records against retention rules and marks expired records
 * for irreversible deletion or cryptographic shredding.
 *
 * @see Requirement 25.2 - Retention rules per classification and per component
 * @see Requirement 25.3 - Irreversible deletion/shredding within 24h of expiry
 */
export interface IRetentionEnforcer {
  /**
   * Evaluates all records for a tenant against retention rules.
   * Marks expired records for deletion/shredding with a 24h deadline.
   *
   * @param tenantId - The tenant whose records to evaluate
   * @param records - The records to evaluate
   * @param now - The current timestamp (for testability)
   * @returns Enforcement result with expired records
   */
  enforce(
    tenantId: string,
    records: readonly RetentionRecord[],
    now?: Date,
  ): Promise<RetentionEnforcementResult>;
}

/**
 * Residency enforcer interface.
 *
 * Validates that data operations comply with the tenant's configured
 * Data_Residency_Region.
 *
 * @see Requirement 25.4 - Data_Residency_Region enforcement
 * @see Requirement 25.5 - Region migration planning
 */
export interface IResidencyEnforcer {
  /**
   * Validates whether a data operation is allowed in the target region.
   *
   * @param request - The validation request
   * @param ctx - The authenticated request context
   * @returns Validation result indicating whether the operation is allowed
   */
  validate(
    request: ResidencyValidationRequest,
    ctx: RequestContext,
  ): Promise<ResidencyValidationResult>;

  /**
   * Produces a migration plan when a tenant changes residency region.
   * Processing in the new region must not begin until migration is complete.
   *
   * @param tenantId - The tenant changing regions
   * @param sourceRegion - The current region
   * @param targetRegion - The new region
   * @returns A migration plan
   */
  createMigrationPlan(
    tenantId: string,
    sourceRegion: string,
    targetRegion: string,
  ): Promise<ResidencyMigrationPlan>;
}
