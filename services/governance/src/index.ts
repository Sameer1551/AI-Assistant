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

// Interfaces
export type {
  IGovernanceService,
  IPIIDetector,
  ITenantPolicyStore,
  PIIMatch,
  RedactionRequest,
  TenantRedactionPolicy,
} from './interfaces/index.js';

// Implementations
export { PIIDetector } from './pii-detector.js';
export { RedactionPipeline } from './redaction-pipeline.js';
export { InMemoryTenantPolicyStore } from './in-memory-tenant-policy-store.js';
