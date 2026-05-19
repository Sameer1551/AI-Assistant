/**
 * Audit event ingestion service implementation.
 *
 * Handles the Ingest RPC: validates required fields, assigns monotonically
 * increasing sequence numbers per tenant, computes SHA-256 chain hashes,
 * signs chain segments, and persists events.
 *
 * @see Requirement 21.1 - Ingest audit events
 * @see Requirement 21.2 - Monotonic sequence numbers and chain hashes
 * @see Requirement 21.3 - Chain segment signing
 * @see Requirement 21.7 - Required fields validation
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditSeverity, PlatformError, RequestContext } from '@may/types';
import type {
  IAuditService,
  IAuditEventStore,
  IChainHasher,
  IChainSigner,
  IngestRequest,
  AuditAck,
  AuditQuery,
  AuditQueryResponse,
  VerifyRequest,
  VerifyResult,
  ChainViolation,
  ChainHashInput,
  RetentionEnforcementResult,
} from './interfaces/index.js';

/** Valid severity values for validation. */
const VALID_SEVERITIES: readonly AuditSeverity[] = [
  'INFO',
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
];

/**
 * Creates a PlatformError for validation failures.
 */
function createValidationError(
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
): PlatformError {
  return {
    code: 'MISSING_REQUIRED_FIELD',
    category: 'VALIDATION',
    severity: 'MEDIUM',
    message,
    correlation_id: correlationId as PlatformError['correlation_id'],
    source_service: 'Audit_Service',
    retryable: false,
    timestamp: new Date().toISOString(),
    details,
  };
}

/**
 * Audit ingestion service with cryptographic chaining.
 *
 * Uses constructor injection for all dependencies:
 * - IAuditEventStore: persistence layer
 * - IChainHasher: SHA-256 hash computation
 * - IChainSigner: chain segment signing
 *
 * Thread safety for sequence number assignment is achieved via
 * per-tenant async locks (serialized ingestion per tenant).
 */
export class AuditIngestionService implements IAuditService {
  /**
   * Per-tenant locks to ensure serialized sequence number assignment.
   * Each tenant's ingestion is serialized to prevent sequence gaps.
   */
  private readonly tenantLocks: Map<string, Promise<void>> = new Map();

  constructor(
    private readonly store: IAuditEventStore,
    private readonly hasher: IChainHasher,
    private readonly signer: IChainSigner,
  ) {}

  /**
   * Ingests a new audit event into the tenant's chain.
   *
   * 1. Validates all required fields
   * 2. Acquires per-tenant lock for serialized sequence assignment
   * 3. Retrieves the last event in the tenant's chain
   * 4. Assigns the next sequence number
   * 5. Computes the chain hash
   * 6. Signs the chain segment
   * 7. Persists the complete event
   *
   * @param request - The audit event data
   * @param ctx - The authenticated request context
   * @returns Acknowledgment with event_id, sequence_number, and chain_hash
   * @throws PlatformError with category VALIDATION if required fields are missing
   */
  async ingest(request: IngestRequest, ctx: RequestContext): Promise<AuditAck> {
    // Step 1: Validate required fields
    this.validateRequest(request, ctx.correlation_id as string);

    // Step 2: Serialize per-tenant to ensure monotonic sequence numbers
    return this.withTenantLock(request.tenant_id, async () => {
      // Step 3: Get the last event in the tenant's chain
      const lastEvent = await this.store.getLastEvent(request.tenant_id);

      // Step 4: Assign next sequence number
      const sequenceNumber = lastEvent ? lastEvent.sequence_number + 1 : 1;

      // Step 5: Generate event_id
      const eventId = randomUUID();

      // Step 6: Compute chain hash
      const hashInput: ChainHashInput = {
        event_id: eventId,
        timestamp: request.timestamp,
        tenant_id: request.tenant_id,
        principal_id: request.principal_id,
        source_service: request.source_service,
        event_category: request.event_category,
        severity: request.severity,
        correlation_id: request.correlation_id,
        outcome: request.outcome,
        payload: request.payload ?? {},
      };

      const previousHash = lastEvent?.chain_hash ?? null;
      const chainHash = this.hasher.computeHash(previousHash, hashInput);

      // Step 7: Sign the chain segment (single event)
      const signature = await this.signer.sign(request.tenant_id, [chainHash]);

      // Step 8: Construct and persist the complete event
      const event: AuditEvent = {
        event_id: eventId,
        sequence_number: sequenceNumber,
        chain_hash: chainHash,
        timestamp: request.timestamp,
        tenant_id: request.tenant_id,
        principal_id: request.principal_id,
        source_service: request.source_service,
        event_category: request.event_category,
        severity: request.severity,
        correlation_id: request.correlation_id,
        outcome: request.outcome,
        payload: request.payload ?? {},
        signature,
      };

      await this.store.append(event);

      return {
        event_id: eventId,
        sequence_number: sequenceNumber,
        chain_hash: chainHash,
      };
    });
  }

  /**
   * Queries audit events for a tenant with optional filters.
   *
   * @param query - Query parameters
   * @param ctx - The authenticated request context
   * @returns Matching events and total count
   */
  async query(query: AuditQuery, ctx: RequestContext): Promise<AuditQueryResponse> {
    // Enforce tenant scoping: always use the authenticated tenant
    const scopedQuery: AuditQuery = {
      ...query,
      tenant_id: ctx.tenant_id as string,
    };
    return this.store.query(scopedQuery);
  }

  /**
   * Verifies the integrity of a tenant's audit chain.
   * Detects sequence gaps, hash mismatches, and missing events.
   *
   * @param request - Verification parameters
   * @param ctx - The authenticated request context
   * @returns Verification result with any violations found
   */
  async verifyChain(request: VerifyRequest, ctx: RequestContext): Promise<VerifyResult> {
    const tenantId = ctx.tenant_id as string;
    const fromSequence = request.from_sequence ?? 1;

    // Get the last event to determine the end of the chain
    const lastEvent = await this.store.getLastEvent(tenantId);
    if (!lastEvent) {
      return { valid: true, events_verified: 0, violations: [] };
    }

    const toSequence = request.to_sequence ?? lastEvent.sequence_number;
    const events = await this.store.getRange(tenantId, fromSequence, toSequence);

    const violations: ChainViolation[] = [];
    let previousHash: string | null = null;

    // If starting from sequence > 1, we need the previous event's hash
    if (fromSequence > 1) {
      const prevEvents = await this.store.getRange(tenantId, fromSequence - 1, fromSequence - 1);
      if (prevEvents.length > 0) {
        previousHash = prevEvents[0]!.chain_hash;
      }
    }

    let expectedSequence = fromSequence;

    for (const event of events) {
      // Check sequence continuity
      if (event.sequence_number !== expectedSequence) {
        if (event.sequence_number > expectedSequence) {
          violations.push({
            type: 'SEQUENCE_GAP',
            at_sequence: expectedSequence,
            description: `Expected sequence ${expectedSequence}, found ${event.sequence_number}`,
          });
        } else {
          violations.push({
            type: 'SEQUENCE_DUPLICATE',
            at_sequence: event.sequence_number,
            description: `Duplicate sequence number ${event.sequence_number}`,
          });
        }
      }

      // Verify chain hash
      const hashInput: ChainHashInput = {
        event_id: event.event_id,
        timestamp: event.timestamp,
        tenant_id: event.tenant_id,
        principal_id: event.principal_id,
        source_service: event.source_service,
        event_category: event.event_category,
        severity: event.severity,
        correlation_id: event.correlation_id,
        outcome: event.outcome,
        payload: event.payload,
      };

      const expectedHash = this.hasher.computeHash(previousHash, hashInput);
      if (event.chain_hash !== expectedHash) {
        violations.push({
          type: 'HASH_MISMATCH',
          at_sequence: event.sequence_number,
          description: `Chain hash mismatch at sequence ${event.sequence_number}`,
        });
      }

      previousHash = event.chain_hash;
      expectedSequence = event.sequence_number + 1;
    }

    // Check for missing events at the end
    if (events.length < toSequence - fromSequence + 1) {
      const foundSequences = new Set(events.map((e) => e.sequence_number));
      for (let seq = fromSequence; seq <= toSequence; seq++) {
        if (!foundSequences.has(seq)) {
          violations.push({
            type: 'MISSING_EVENT',
            at_sequence: seq,
            description: `Missing event at sequence ${seq}`,
          });
        }
      }
    }

    return {
      valid: violations.length === 0,
      events_verified: events.length,
      violations,
    };
  }

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
  async enforceRetention(tenantId: string, retentionDays: number): Promise<RetentionEnforcementResult> {
    // Enforce minimum 365 days retention
    const effectiveRetentionDays = Math.max(retentionDays, 365);

    // Calculate cutoff timestamp
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - effectiveRetentionDays * 24 * 60 * 60 * 1000);
    const cutoffTimestamp = cutoffDate.toISOString();

    // Delete events older than the cutoff
    const eventsDeleted = await this.store.deleteOlderThan(tenantId, cutoffTimestamp);

    return {
      tenant_id: tenantId,
      events_marked: eventsDeleted,
      events_deleted: eventsDeleted,
      cutoff_timestamp: cutoffTimestamp,
    };
  }

  /**
   * Validates all required fields in an ingest request.
   * Throws a PlatformError if any required field is missing or empty.
   */
  private validateRequest(request: IngestRequest, correlationId: string): void {
    const requiredFields: ReadonlyArray<{ field: keyof IngestRequest; label: string }> = [
      { field: 'timestamp', label: 'timestamp' },
      { field: 'tenant_id', label: 'tenant_id' },
      { field: 'principal_id', label: 'principal_id' },
      { field: 'source_service', label: 'source_service' },
      { field: 'event_category', label: 'event_category' },
      { field: 'severity', label: 'severity' },
      { field: 'correlation_id', label: 'correlation_id' },
      { field: 'outcome', label: 'outcome' },
    ];

    const missingFields: string[] = [];

    for (const { field, label } of requiredFields) {
      const value = request[field];
      if (value === undefined || value === null || value === '') {
        missingFields.push(label);
      }
    }

    if (missingFields.length > 0) {
      throw createValidationError(
        `Missing required fields: ${missingFields.join(', ')}`,
        correlationId,
        { missing_fields: missingFields },
      );
    }

    // Validate severity is a valid value
    if (!VALID_SEVERITIES.includes(request.severity)) {
      throw createValidationError(
        `Invalid severity value: ${request.severity}. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
        correlationId,
        { field: 'severity', value: request.severity },
      );
    }
  }

  /**
   * Executes an async operation under a per-tenant lock.
   * Ensures serialized access to sequence number assignment per tenant.
   */
  private async withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    // Chain the operation after any pending operation for this tenant
    const currentLock = this.tenantLocks.get(tenantId) ?? Promise.resolve();

    let resolve: () => void;
    const newLock = new Promise<void>((r) => {
      resolve = r;
    });
    this.tenantLocks.set(tenantId, newLock);

    // Wait for previous operation to complete
    await currentLock;

    try {
      return await fn();
    } finally {
      resolve!();
    }
  }
}
