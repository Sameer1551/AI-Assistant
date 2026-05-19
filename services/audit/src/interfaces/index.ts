/**
 * Audit service interfaces.
 * Service contracts and dependency injection interfaces.
 *
 * @see Requirement 21 - Tamper-Evident Audit Logging
 */

import type { AuditEvent, AuditSeverity, RequestContext } from '@may/types';

// Re-export SIEM and buffer interfaces
export type {
  ISIEMForwarder,
  SIEMEndpointConfig,
  ForwardResult,
} from './siem-forwarder.js';

export type {
  IDurableBuffer,
  BufferedEntry,
} from './durable-buffer.js';

// ─── Ingest Request / Response ───────────────────────────────────────────────

/**
 * Request to ingest a new audit event.
 * The caller provides all required fields except sequence_number and chain_hash,
 * which are assigned server-side by the Audit_Service.
 */
export interface IngestRequest {
  /** ISO 8601 timestamp of the audited operation */
  readonly timestamp: string;
  /** Tenant boundary identifier */
  readonly tenant_id: string;
  /** Principal (user or service) that triggered the event */
  readonly principal_id: string;
  /** The service that emitted this event */
  readonly source_service: string;
  /** Category of the event (e.g., "action.executed", "auth.decision") */
  readonly event_category: string;
  /** Severity classification */
  readonly severity: AuditSeverity;
  /** Correlation identifier linking to the originating request */
  readonly correlation_id: string;
  /** Outcome of the audited operation */
  readonly outcome: string;
  /** Additional structured payload data */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Acknowledgment returned after successful ingestion.
 */
export interface AuditAck {
  /** The assigned event_id (UUID) */
  readonly event_id: string;
  /** The assigned sequence number in the tenant's chain */
  readonly sequence_number: number;
  /** The computed chain hash for this event */
  readonly chain_hash: string;
}

// ─── Query Request / Response ────────────────────────────────────────────────

/**
 * Query parameters for retrieving audit events.
 */
export interface AuditQuery {
  /** Tenant to query (required, enforced by service) */
  readonly tenant_id: string;
  /** Optional start of time range (ISO 8601) */
  readonly from_timestamp?: string;
  /** Optional end of time range (ISO 8601) */
  readonly to_timestamp?: string;
  /** Optional filter by source service */
  readonly source_service?: string;
  /** Optional filter by event category */
  readonly event_category?: string;
  /** Optional filter by severity */
  readonly severity?: AuditSeverity;
  /** Optional filter by correlation_id */
  readonly correlation_id?: string;
  /** Maximum number of results to return (default 100) */
  readonly limit?: number;
  /** Offset for pagination */
  readonly offset?: number;
}

/**
 * Response from an audit query.
 */
export interface AuditQueryResponse {
  /** Matching audit events, ordered by sequence_number ascending */
  readonly events: readonly AuditEvent[];
  /** Total count of matching events (for pagination) */
  readonly total_count: number;
}

// ─── Verify Request / Response ───────────────────────────────────────────────

/**
 * Request to verify the integrity of a tenant's audit chain.
 */
export interface VerifyRequest {
  /** Tenant whose chain to verify */
  readonly tenant_id: string;
  /** Optional start sequence number (default: 1) */
  readonly from_sequence?: number;
  /** Optional end sequence number (default: latest) */
  readonly to_sequence?: number;
}

/** Types of chain integrity violations. */
export type ChainViolationType =
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_DUPLICATE'
  | 'HASH_MISMATCH'
  | 'MISSING_EVENT'
  | 'SIGNATURE_INVALID';

/**
 * A single chain integrity violation.
 */
export interface ChainViolation {
  /** Type of violation detected */
  readonly type: ChainViolationType;
  /** Sequence number where the violation was detected */
  readonly at_sequence: number;
  /** Human-readable description of the violation */
  readonly description: string;
}

/**
 * Result of a chain verification.
 */
export interface VerifyResult {
  /** Whether the chain is valid (no violations) */
  readonly valid: boolean;
  /** Number of events verified */
  readonly events_verified: number;
  /** List of violations found (empty if valid) */
  readonly violations: readonly ChainViolation[];
}

// ─── Service Interfaces ──────────────────────────────────────────────────────

/**
 * Main Audit_Service interface.
 * Provides tamper-evident audit logging with cryptographic chaining.
 *
 * @see Requirement 21.1 - Ingest audit events
 * @see Requirement 21.2 - Monotonic sequence numbers and chain hashes
 * @see Requirement 21.3 - Chain verification
 */
export interface IAuditService {
  /**
   * Ingests a new audit event into the tenant's chain.
   * Assigns sequence_number and chain_hash server-side.
   * Validates all required fields before acceptance.
   *
   * @param request - The audit event data (without sequence/hash)
   * @param ctx - The authenticated request context
   * @returns Acknowledgment with assigned event_id, sequence_number, and chain_hash
   * @throws PlatformError with category VALIDATION if required fields are missing/empty
   */
  ingest(request: IngestRequest, ctx: RequestContext): Promise<AuditAck>;

  /**
   * Queries audit events for a tenant with optional filters.
   *
   * @param query - Query parameters
   * @param ctx - The authenticated request context
   * @returns Matching events and total count
   */
  query(query: AuditQuery, ctx: RequestContext): Promise<AuditQueryResponse>;

  /**
   * Verifies the integrity of a tenant's audit chain.
   * Detects insertion, deletion, or modification of events.
   *
   * @param request - Verification parameters
   * @param ctx - The authenticated request context
   * @returns Verification result with any violations found
   */
  verifyChain(request: VerifyRequest, ctx: RequestContext): Promise<VerifyResult>;

  /**
   * Enforces retention policy for a tenant.
   * Deletes events older than the configured retention period.
   * Minimum retention is 365 days regardless of tenant configuration.
   *
   * @param tenantId - The tenant whose events to evaluate
   * @param retentionDays - Tenant-configured retention in days (minimum 365)
   * @returns Result of the enforcement operation
   *
   * @see Requirement 21.4 - Retention enforcement (≥365 days minimum)
   */
  enforceRetention(tenantId: string, retentionDays: number): Promise<RetentionEnforcementResult>;
}

// ─── Persistence Interface ───────────────────────────────────────────────────

/**
 * Result of a retention enforcement operation.
 */
export interface RetentionEnforcementResult {
  /** Tenant whose events were evaluated */
  readonly tenant_id: string;
  /** Number of events marked for deletion */
  readonly events_marked: number;
  /** Number of events deleted */
  readonly events_deleted: number;
  /** The cutoff timestamp used (events older than this are eligible) */
  readonly cutoff_timestamp: string;
}

/**
 * Persistence layer for audit events.
 * Implementations must guarantee ordering by sequence_number within a tenant.
 */
export interface IAuditEventStore {
  /**
   * Appends an event to the store.
   *
   * @param event - The complete audit event to persist
   */
  append(event: AuditEvent): Promise<void>;

  /**
   * Retrieves the last event in a tenant's chain.
   * Returns null if the tenant has no events.
   *
   * @param tenantId - The tenant identifier
   * @returns The last event or null
   */
  getLastEvent(tenantId: string): Promise<AuditEvent | null>;

  /**
   * Queries events for a tenant with optional filters.
   *
   * @param query - Query parameters
   * @returns Matching events and total count
   */
  query(query: AuditQuery): Promise<AuditQueryResponse>;

  /**
   * Retrieves events in a sequence range for chain verification.
   *
   * @param tenantId - The tenant identifier
   * @param fromSequence - Start sequence number (inclusive)
   * @param toSequence - End sequence number (inclusive)
   * @returns Events in the specified range, ordered by sequence_number
   */
  getRange(tenantId: string, fromSequence: number, toSequence: number): Promise<readonly AuditEvent[]>;

  /**
   * Deletes events older than the specified cutoff timestamp for a tenant.
   *
   * @param tenantId - The tenant identifier
   * @param cutoffTimestamp - ISO 8601 timestamp; events with timestamp < cutoff are deleted
   * @returns Number of events deleted
   */
  deleteOlderThan(tenantId: string, cutoffTimestamp: string): Promise<number>;

  /**
   * Returns all tenant IDs that have stored events.
   */
  getTenantIds(): Promise<readonly string[]>;
}

// ─── Chain Hasher Interface ──────────────────────────────────────────────────

/**
 * Computes SHA-256 chain hashes for audit events.
 * Each hash links an event to the previous event in the tenant's chain.
 *
 * @see Requirement 21.2 - SHA-256 chain hash
 */
export interface IChainHasher {
  /**
   * Computes the chain hash for an event.
   *
   * chain_hash = SHA-256(previous_chain_hash + serialized_event_fields)
   * For the first event: SHA-256("genesis" + serialized_event_fields)
   *
   * @param previousHash - The chain_hash of the previous event, or null for genesis
   * @param eventFields - The event fields to include in the hash
   * @returns The computed SHA-256 hex hash
   */
  computeHash(previousHash: string | null, eventFields: ChainHashInput): string;
}

/**
 * Fields included in the chain hash computation.
 * These are the immutable fields of an audit event that form the hash input.
 */
export interface ChainHashInput {
  readonly event_id: string;
  readonly timestamp: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly source_service: string;
  readonly event_category: string;
  readonly severity: AuditSeverity;
  readonly correlation_id: string;
  readonly outcome: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ─── Chain Signer Interface ──────────────────────────────────────────────────

/**
 * Signs chain segments using keys from the Secrets_Service.
 * Provides non-repudiation for audit chain segments.
 *
 * @see Requirement 21.3 - Chain segment signing
 */
export interface IChainSigner {
  /**
   * Signs a chain segment (one or more consecutive chain hashes).
   *
   * @param tenantId - The tenant whose chain segment to sign
   * @param chainHashes - Ordered array of chain hashes to sign
   * @returns The signature (hex-encoded)
   */
  sign(tenantId: string, chainHashes: readonly string[]): Promise<string>;

  /**
   * Verifies a chain segment signature.
   *
   * @param tenantId - The tenant whose chain segment to verify
   * @param chainHashes - Ordered array of chain hashes that were signed
   * @param signature - The signature to verify
   * @returns True if the signature is valid
   */
  verify(tenantId: string, chainHashes: readonly string[], signature: string): Promise<boolean>;
}
