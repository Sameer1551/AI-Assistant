/**
 * Governance service interfaces.
 * Service contracts and dependency injection interfaces.
 *
 * @see Requirement 25 - Data Classification, Retention, and Residency
 * @see Requirement 26 - PII Detection and Redaction
 * @see Requirement 27 - Data Subject Rights
 */

export type {
  ClassifyRequest,
  ClassifyResult,
  RetentionRule,
  RetentionRecord,
  RetentionEnforcementResult,
  ExpiredRecord,
  ResidencyValidationRequest,
  ResidencyValidationResult,
  ResidencyMigrationPlan,
  MigrationStep,
  ITenantTaxonomyStore,
  IClassificationService,
  IRetentionEnforcer,
  IResidencyEnforcer,
} from './classification-service.js';

export type {
  IDSARService,
  IDSARStore,
  IDataOwningService,
  ILegalHoldChecker,
  IDSARClock,
  IDSARIdGenerator,
  SubmitDSARRequest,
  DSARAcknowledgment,
  ErasureResult,
  LegalHoldExclusion,
  DSARExportResult,
} from './dsar-service.js';

// ─── PII / Redaction Interfaces ──────────────────────────────────────────────
// These interfaces support the PII detection and redaction pipeline.

import type { PIICategory, RequestContext, RedactionResult } from '@may/types';

/**
 * A single PII match found in content.
 */
export interface PIIMatch {
  /** The category of PII detected */
  readonly category: PIICategory;
  /** Confidence score [0.0, 1.0] */
  readonly confidence: number;
  /** Start character offset */
  readonly start_offset: number;
  /** End character offset */
  readonly end_offset: number;
  /** The matched text */
  readonly matched_text: string;
}

/**
 * PII detector interface.
 */
export interface IPIIDetector {
  /**
   * Detect PII in the given content.
   *
   * @param content - The text content to scan
   * @param categories - Optional subset of categories to detect
   * @returns Array of PII matches found
   */
  detect(content: string, categories?: readonly PIICategory[]): PIIMatch[];
}

/**
 * Tenant-specific redaction policy configuration.
 */
export interface TenantRedactionPolicy {
  /** Tenant identifier */
  readonly tenant_id: string;
  /** The policy configuration */
  readonly policy: {
    /** Redaction posture: block, flag, or redact */
    readonly posture: 'block' | 'flag' | 'redact';
    /** Minimum confidence threshold for detection [0.0, 1.0] */
    readonly confidence_threshold: number;
    /** PII categories to detect (empty = all) */
    readonly categories?: readonly PIICategory[];
  };
  /** Policy version string */
  readonly version: string;
}

/**
 * Store for tenant redaction policies.
 */
export interface ITenantPolicyStore {
  /**
   * Get the redaction policy for a tenant.
   * Returns null if no policy is configured.
   */
  getRedactionPolicy(tenantId: string): Promise<TenantRedactionPolicy | null>;

  /**
   * Set or update the redaction policy for a tenant.
   */
  setRedactionPolicy(tenantId: string, policy: TenantRedactionPolicy): Promise<void>;

  /**
   * Remove the redaction policy for a tenant.
   */
  removeRedactionPolicy(tenantId: string): Promise<void>;
}

/**
 * Request to redact PII from content.
 */
export interface RedactionRequest {
  /** The content to redact */
  readonly content: string;
  /** Tenant identifier for policy lookup */
  readonly tenant_id: string;
  /** Destination where the redacted content will be sent */
  readonly destination: string;
}

/**
 * Main governance service interface for PII redaction.
 *
 * @see Requirement 26 - PII Detection and Redaction
 */
export interface IGovernanceService {
  /**
   * Redact PII from content according to tenant policy.
   *
   * @param request - The redaction request
   * @param ctx - Authenticated request context
   * @returns Redaction result with report
   */
  redact(request: RedactionRequest, ctx: RequestContext): Promise<RedactionResult>;
}
