/**
 * @module governance
 * Data governance models for the Governance_Service.
 *
 * The Governance_Service enforces data classification, retention,
 * PII detection/redaction, residency enforcement, and DSAR processing.
 *
 * @see Requirement 25.1 - Tenant-configurable data classification taxonomy
 * @see Requirement 26.1 - PII detection categories
 * @see Requirement 27.1 - DSAR request types
 */

/**
 * Tenant-configurable data classification taxonomy.
 *
 * Classifications determine retention rules, access controls,
 * and handling requirements for data across the platform.
 */
export type DataClassification =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'regulated_pii'
  | 'regulated_health'
  | 'regulated_financial';

/**
 * PII categories that the Governance_Service can detect and redact.
 *
 * Includes names, addresses, phone numbers, email addresses,
 * government IDs, payment cards, bank accounts, IP addresses,
 * geolocation data, dates of birth, and credentials.
 */
export type PIICategory =
  | 'name'
  | 'address'
  | 'phone'
  | 'email'
  | 'government_id'
  | 'payment_card'
  | 'bank_account'
  | 'ip_address'
  | 'geolocation'
  | 'date_of_birth'
  | 'credential';

/**
 * Action taken on a detected PII instance based on tenant policy.
 */
export type PIIAction = 'redacted' | 'flagged' | 'blocked';

/**
 * A single PII detection within content, including its location,
 * category, confidence, and the action taken.
 */
export interface PIIDetection {
  /** The category of PII detected */
  readonly category: PIICategory;

  /** Confidence score of the detection [0.0, 1.0] */
  readonly confidence: number;

  /** Start character offset in the original content */
  readonly start_offset: number;

  /** End character offset in the original content */
  readonly end_offset: number;

  /** The action taken on this detection based on tenant policy */
  readonly action_taken: PIIAction;
}

/**
 * Result of a redaction operation, including the redacted content,
 * a hash of the original for verification, and all detections.
 */
export interface RedactionResult {
  /** SHA-256 hash of the original content before redaction */
  readonly original_hash: string;

  /** Content after redaction has been applied */
  readonly redacted_content: string;

  /** All PII detections found in the content */
  readonly detections: readonly PIIDetection[];

  /** Version of the redaction policy that was applied */
  readonly policy_version: string;

  /** Destination where the redacted content will be sent */
  readonly destination: string;
}

/**
 * Types of Data Subject Access Requests (DSAR) supported.
 *
 * - access: Request to view personal data held
 * - rectification: Request to correct inaccurate data
 * - export: Request for a machine-readable data export
 * - erasure: Request to delete personal data
 */
export type DSARRequestType = 'access' | 'rectification' | 'export' | 'erasure';

/**
 * Status of a DSAR request through its lifecycle.
 */
export type DSARStatus =
  | 'received'
  | 'acknowledged'
  | 'in_progress'
  | 'completed'
  | 'partially_completed';

/**
 * A Data Subject Access Request (DSAR) tracking the lifecycle
 * of a data subject's request across all owning services.
 *
 * DSARs must be acknowledged within 72 hours and responded to
 * within 30 calendar days. Erasure orders are issued to all
 * owning services and tracked per-service.
 */
export interface DSARRequest {
  /** Unique identifier for this DSAR (UUID) */
  readonly dsar_id: string;

  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Identifier of the data subject making the request */
  readonly data_subject_id: string;

  /** Type of DSAR request */
  readonly request_type: DSARRequestType;

  /** ISO 8601 timestamp when the request was submitted */
  readonly submitted_at: string;

  /** ISO 8601 timestamp when the request was acknowledged (within 72h) */
  readonly acknowledged_at?: string;

  /** ISO 8601 due date (30 calendar days from submission) */
  readonly due_date: string;

  /** Current status of the DSAR */
  readonly status: DSARStatus;

  /** Per-service completion tracking (service name → completed) */
  readonly service_completion: Readonly<Record<string, boolean>>;
}
