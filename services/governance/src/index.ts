/**
 * @may/governance - Governance Service
 *
 * Data classification, retention enforcement, PII detection/redaction,
 * residency enforcement, and DSAR processing.
 *
 * @see Requirement 25 - Data Classification and Retention
 * @see Requirement 26 - PII Detection and Redaction
 * @see Requirement 27 - DSAR Processing
 */

// Interfaces - Classification, Retention, Residency (Task 5.3)
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
  // DSAR interfaces (Task 5.5)
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
} from './interfaces/index.js';

// Implementations - Classification, Retention, Residency (Task 5.3)
export { ClassificationService } from './classification-service.js';
export { RetentionEnforcer } from './retention-enforcer.js';
export { ResidencyEnforcer } from './residency-enforcer.js';
export { InMemoryTenantTaxonomyStore } from './in-memory-tenant-taxonomy-store.js';

// Implementations - PII Detection and Redaction (Task 5.1)
export { PIIDetector } from './pii-detector.js';
export { RedactionPipeline } from './redaction-pipeline.js';
export { InMemoryTenantPolicyStore } from './in-memory-tenant-policy-store.js';

// Implementations - DSAR (Task 5.5)
export { DSARService } from './dsar-service.js';
export { InMemoryDSARStore } from './in-memory-dsar-store.js';
