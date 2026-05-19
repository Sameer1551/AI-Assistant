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
