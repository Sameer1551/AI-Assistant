/**
 * @module audit
 * Audit event data models for the Audit_Service.
 *
 * The Audit_Service provides tamper-evident audit logging with cryptographic
 * chaining (SHA-256) and SIEM forwarding. Each event has a monotonically
 * increasing sequence number and a chain hash linking it to the previous
 * event in the same tenant's chain.
 *
 * @see Requirement 21.2 - Monotonically increasing sequence number and chain hash
 * @see Requirement 21.7 - Required fields for every audit event
 */

/**
 * Severity levels for audit events, ordered from informational to critical.
 */
export type AuditSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * A tamper-evident audit event with cryptographic chaining.
 *
 * Each event is linked to the previous event in the same tenant's chain
 * via a SHA-256 chain_hash. Sequence numbers are monotonically increasing
 * per tenant chain, enabling detection of insertion, deletion, or
 * modification of historical events.
 */
export interface AuditEvent {
  /** Unique identifier for this event (UUID) */
  readonly event_id: string;

  /**
   * Monotonically increasing sequence number within the tenant's chain.
   * Each new event must have a sequence_number strictly greater than
   * the previous event in the same tenant chain.
   */
  readonly sequence_number: number;

  /**
   * SHA-256 hash linking this event to the previous event in the
   * tenant's chain. Enables tamper detection.
   */
  readonly chain_hash: string;

  /** ISO 8601 timestamp with nanosecond precision */
  readonly timestamp: string;

  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Principal (user or service) that triggered this event */
  readonly principal_id: string;

  /** The service that emitted this event */
  readonly source_service: string;

  /** Category of the event (e.g., "action.executed", "auth.decision") */
  readonly event_category: string;

  /** Severity classification of the event */
  readonly severity: AuditSeverity;

  /** Correlation identifier linking to the originating request */
  readonly correlation_id: string;

  /** Outcome of the audited operation */
  readonly outcome: string;

  /** Additional structured payload data */
  readonly payload: Readonly<Record<string, unknown>>;

  /** Optional chain segment signature from the Secrets_Service */
  readonly signature?: string;
}
