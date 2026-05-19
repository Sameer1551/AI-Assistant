/**
 * DSAR (Data Subject Access Request) service interface.
 *
 * Defines the contract for processing data subject rights requests
 * including access, rectification, export, and erasure.
 *
 * @see Requirement 27.1 - Documented intake interface for DSAR submissions
 * @see Requirement 27.2 - Acknowledge within 72h, respond within 30 days
 * @see Requirement 27.3 - Issue erasure orders to all owning services
 * @see Requirement 27.4 - Exclude records under legal hold
 * @see Requirement 27.5 - Machine-readable export within 30 days
 */

import type { DSARRequest, DSARRequestType, DSARStatus, RequestContext } from '@may/types';

// ─── Request / Response Types ────────────────────────────────────────────────

/**
 * Request to submit a new DSAR.
 */
export interface SubmitDSARRequest {
  /** Identifier of the data subject making the request */
  readonly data_subject_id: string;
  /** Type of DSAR request */
  readonly request_type: DSARRequestType;
  /** Optional description or details about the request */
  readonly description?: string;
}

/**
 * Acknowledgment returned after DSAR submission.
 */
export interface DSARAcknowledgment {
  /** The assigned DSAR identifier */
  readonly dsar_id: string;
  /** ISO 8601 timestamp of acknowledgment */
  readonly acknowledged_at: string;
  /** ISO 8601 due date (30 calendar days from submission) */
  readonly due_date: string;
  /** Current status */
  readonly status: DSARStatus;
}

/**
 * Result of an erasure processing operation.
 */
export interface ErasureResult {
  /** The DSAR identifier */
  readonly dsar_id: string;
  /** Per-service erasure completion status */
  readonly service_completion: Readonly<Record<string, boolean>>;
  /** Services excluded due to legal hold */
  readonly legal_hold_exclusions: readonly LegalHoldExclusion[];
  /** Whether all non-held services completed erasure */
  readonly fully_completed: boolean;
}

/**
 * A record excluded from erasure due to legal hold.
 */
export interface LegalHoldExclusion {
  /** The service holding the record */
  readonly service_name: string;
  /** Documented legal basis for the hold */
  readonly legal_basis: string;
  /** ISO 8601 timestamp when the hold was applied */
  readonly hold_applied_at: string;
}

/**
 * Machine-readable export of a data subject's personal data.
 */
export interface DSARExportResult {
  /** The DSAR identifier */
  readonly dsar_id: string;
  /** Format of the export (e.g., 'application/json') */
  readonly format: string;
  /** The exported data as a structured object */
  readonly data: Readonly<Record<string, unknown>>;
  /** ISO 8601 timestamp when the export was generated */
  readonly generated_at: string;
  /** Services that contributed data to the export */
  readonly contributing_services: readonly string[];
}

// ─── Service Interface ───────────────────────────────────────────────────────

/**
 * Main DSAR service interface.
 *
 * Provides intake, acknowledgment, erasure processing, and export
 * generation for data subject access requests.
 *
 * @see Requirement 27 - Data Subject Rights
 */
export interface IDSARService {
  /**
   * Submit a new DSAR request.
   * Automatically acknowledges within 72 hours and sets a 30-day due date.
   *
   * @param request - The DSAR submission details
   * @param ctx - Authenticated request context
   * @returns Acknowledgment with DSAR ID and due date
   *
   * @see Requirement 27.1 - Intake interface
   * @see Requirement 27.2 - Acknowledge within 72h
   */
  submitRequest(request: SubmitDSARRequest, ctx: RequestContext): Promise<DSARAcknowledgment>;

  /**
   * Acknowledge a previously submitted DSAR.
   * Must occur within 72 hours of submission.
   *
   * @param dsarId - The DSAR identifier to acknowledge
   * @param ctx - Authenticated request context
   * @returns Updated acknowledgment
   *
   * @see Requirement 27.2 - Acknowledge within 72h
   */
  acknowledge(dsarId: string, ctx: RequestContext): Promise<DSARAcknowledgment>;

  /**
   * Process an erasure DSAR by issuing erasure orders to all owning services.
   * Tracks per-service completion and excludes records under legal hold.
   *
   * @param dsarId - The DSAR identifier to process
   * @param ctx - Authenticated request context
   * @returns Erasure result with per-service completion status
   *
   * @see Requirement 27.3 - Issue erasure orders to all owning services
   * @see Requirement 27.4 - Exclude records under legal hold
   */
  processErasure(dsarId: string, ctx: RequestContext): Promise<ErasureResult>;

  /**
   * Generate a machine-readable export of a data subject's personal data.
   * Must be produced within 30 calendar days of an export DSAR.
   *
   * @param dsarId - The DSAR identifier to generate export for
   * @param ctx - Authenticated request context
   * @returns Machine-readable export result
   *
   * @see Requirement 27.5 - Machine-readable export within 30 days
   */
  generateExport(dsarId: string, ctx: RequestContext): Promise<DSARExportResult>;

  /**
   * Get the current status of a DSAR.
   *
   * @param dsarId - The DSAR identifier
   * @param ctx - Authenticated request context
   * @returns The current DSAR request state
   */
  getRequest(dsarId: string, ctx: RequestContext): Promise<DSARRequest | null>;
}

// ─── Dependency Interfaces ───────────────────────────────────────────────────

/**
 * Persistence layer for DSAR requests.
 */
export interface IDSARStore {
  /**
   * Save a DSAR request.
   */
  save(request: DSARRequest): Promise<void>;

  /**
   * Find a DSAR by its ID within a tenant.
   */
  findById(dsarId: string, tenantId: string): Promise<DSARRequest | null>;

  /**
   * Update a DSAR request.
   */
  update(request: DSARRequest): Promise<void>;

  /**
   * Find all DSARs for a given data subject within a tenant.
   */
  findByDataSubject(dataSubjectId: string, tenantId: string): Promise<readonly DSARRequest[]>;
}

/**
 * Interface for services that own personal data and can process erasure orders.
 */
export interface IDataOwningService {
  /** Name of the service */
  readonly serviceName: string;

  /**
   * Execute an erasure order for a data subject.
   * Returns true if erasure was completed successfully.
   */
  executeErasure(dataSubjectId: string, tenantId: string): Promise<boolean>;

  /**
   * Export personal data for a data subject.
   * Returns the data held by this service.
   */
  exportData(dataSubjectId: string, tenantId: string): Promise<Record<string, unknown>>;
}

/**
 * Interface for checking legal hold status on records.
 */
export interface ILegalHoldChecker {
  /**
   * Check if a service has records under legal hold for a data subject.
   * Returns the legal basis if a hold exists, or null if no hold.
   */
  checkHold(
    serviceName: string,
    dataSubjectId: string,
    tenantId: string,
  ): Promise<LegalHoldExclusion | null>;
}

/**
 * Clock abstraction for testable time-dependent logic.
 */
export interface IDSARClock {
  /** Returns the current time as an ISO 8601 string */
  now(): string;
}

/**
 * ID generator for creating unique identifiers.
 */
export interface IDSARIdGenerator {
  /** Generate a new UUID v4 string */
  uuid(): string;
}
