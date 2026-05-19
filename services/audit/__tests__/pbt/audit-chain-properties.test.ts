/**
 * Property-based tests for audit chain integrity and event completeness.
 *
 * **Validates: Requirements 21.2, 21.3, 21.7**
 *
 * Property 5: Audit Event Integrity Chain — monotonic sequence numbers,
 *   correct chain hashes, tamper detection
 * Property 6: Audit Event Completeness — all required fields present and non-empty
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import type { RequestContext, AuditSeverity } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { AuditIngestionService } from '../../src/audit-ingestion-service.js';
import { SHA256ChainHasher } from '../../src/sha256-chain-hasher.js';
import { HMACChainSigner } from '../../src/chain-signer.js';
import { InMemoryAuditEventStore } from '../../src/in-memory-audit-event-store.js';
import type { ISigningKeyProvider } from '../../src/chain-signer.js';
import type { IngestRequest } from '../../src/interfaces/index.js';

// ─── Stub Implementations ────────────────────────────────────────────────────

/** Stub signing key provider that returns a deterministic key per tenant. */
class StubSigningKeyProvider implements ISigningKeyProvider {
  async getSigningKey(tenantId: string): Promise<string> {
    return Buffer.from(`test-signing-key-${tenantId}`).toString('base64');
  }
}

function createTestContext(tenantId = 'tenant-1'): RequestContext {
  return {
    tenant_id: tenantId as TenantId,
    principal_id: 'principal-1' as PrincipalId,
    correlation_id: 'corr-123' as CorrelationId,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'session-1' as SessionId,
    roles: ['Auditor'],
    attributes: {},
    residency_region: 'us-east-1',
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Valid severity values for generating audit events. */
const VALID_SEVERITIES: AuditSeverity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Arbitrary for a valid AuditSeverity. */
const severityArb = fc.constantFrom(...VALID_SEVERITIES);

/** Arbitrary for non-empty strings suitable for required fields. */
const nonEmptyStringArb = fc.stringOf(
  fc.char().filter((c) => c.trim().length > 0),
  { minLength: 1, maxLength: 50 },
).filter((s) => s.trim().length > 0);

/** Arbitrary for ISO 8601 timestamps. */
const timestampArb = fc.date({
  min: new Date('2020-01-01T00:00:00Z'),
  max: new Date('2030-12-31T23:59:59Z'),
}).map((d) => d.toISOString());

/** Arbitrary for a valid IngestRequest. */
const validIngestRequestArb = fc.record({
  timestamp: timestampArb,
  tenant_id: fc.constant('tenant-1'),
  principal_id: nonEmptyStringArb,
  source_service: nonEmptyStringArb,
  event_category: nonEmptyStringArb,
  severity: severityArb,
  correlation_id: nonEmptyStringArb,
  outcome: nonEmptyStringArb,
  payload: fc.constant({} as Record<string, unknown>),
}) as fc.Arbitrary<IngestRequest>;

/** Arbitrary for a sequence of valid IngestRequests (1 to 20 events). */
const ingestRequestSequenceArb = fc.array(validIngestRequestArb, { minLength: 1, maxLength: 20 });

// ─── Property 5: Audit Event Integrity Chain ─────────────────────────────────

describe('Property 5: Audit Event Integrity Chain', () => {
  let store: InMemoryAuditEventStore;
  let hasher: SHA256ChainHasher;
  let signer: HMACChainSigner;
  let service: AuditIngestionService;
  let ctx: RequestContext;

  beforeEach(() => {
    store = new InMemoryAuditEventStore();
    hasher = new SHA256ChainHasher();
    signer = new HMACChainSigner(new StubSigningKeyProvider());
    service = new AuditIngestionService(store, hasher, signer);
    ctx = createTestContext();
  });

  /**
   * **Validates: Requirements 21.2**
   *
   * For ANY sequence of valid IngestRequests ingested into the same tenant chain,
   * the assigned sequence numbers MUST be strictly monotonically increasing
   * (each subsequent event has sequence_number = previous + 1).
   */
  it('sequence numbers are strictly monotonically increasing for any event sequence', async () => {
    await fc.assert(
      fc.asyncProperty(ingestRequestSequenceArb, async (requests) => {
        // Fresh service for each run
        const localStore = new InMemoryAuditEventStore();
        const localService = new AuditIngestionService(localStore, hasher, signer);

        const acks = [];
        for (const request of requests) {
          const ack = await localService.ingest(request, ctx);
          acks.push(ack);
        }

        // Verify strict monotonic increase
        for (let i = 0; i < acks.length; i++) {
          expect(acks[i]!.sequence_number).toBe(i + 1);
        }

        // Verify each consecutive pair has strictly increasing sequence
        for (let i = 1; i < acks.length; i++) {
          expect(acks[i]!.sequence_number).toBeGreaterThan(acks[i - 1]!.sequence_number);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 21.2**
   *
   * For ANY sequence of valid IngestRequests, the chain hashes link correctly:
   * each event's chain_hash is computed from the previous event's chain_hash
   * and the current event's fields. The chain verification must pass.
   */
  it('chain hashes link correctly and verification passes for any valid sequence', async () => {
    await fc.assert(
      fc.asyncProperty(ingestRequestSequenceArb, async (requests) => {
        const localStore = new InMemoryAuditEventStore();
        const localService = new AuditIngestionService(localStore, hasher, signer);

        for (const request of requests) {
          await localService.ingest(request, ctx);
        }

        // Verify the entire chain passes integrity check
        const result = await localService.verifyChain(
          { tenant_id: 'tenant-1' },
          ctx,
        );

        expect(result.valid).toBe(true);
        expect(result.events_verified).toBe(requests.length);
        expect(result.violations).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 21.3**
   *
   * For ANY sequence of ≥2 events, modifying any stored event's chain_hash
   * MUST cause the chain verification to detect a HASH_MISMATCH violation.
   */
  it('modifying any event chain_hash breaks verification (tamper detection)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validIngestRequestArb, { minLength: 2, maxLength: 10 }),
        fc.nat(),
        async (requests, tamperSeed) => {
          const localStore = new InMemoryAuditEventStore();
          const localService = new AuditIngestionService(localStore, hasher, signer);

          for (const request of requests) {
            await localService.ingest(request, ctx);
          }

          // Pick an event to tamper with
          const tamperIndex = tamperSeed % requests.length;
          const tamperSequence = tamperIndex + 1;

          // Get all events and tamper with one
          const events = await localStore.getRange('tenant-1', 1, requests.length);
          const tamperedStore = new InMemoryAuditEventStore();

          for (let i = 0; i < events.length; i++) {
            if (i === tamperIndex) {
              // Tamper with the chain_hash
              const tamperedEvent = {
                ...events[i]!,
                chain_hash: 'tampered_' + events[i]!.chain_hash.slice(9),
              };
              await tamperedStore.append(tamperedEvent);
            } else {
              await tamperedStore.append(events[i]!);
            }
          }

          // Verify with tampered store
          const tamperedService = new AuditIngestionService(tamperedStore, hasher, signer);
          const result = await tamperedService.verifyChain(
            { tenant_id: 'tenant-1' },
            ctx,
          );

          expect(result.valid).toBe(false);
          expect(result.violations.length).toBeGreaterThan(0);
          // At least one HASH_MISMATCH should be detected
          const hashMismatches = result.violations.filter((v) => v.type === 'HASH_MISMATCH');
          expect(hashMismatches.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 21.2**
   *
   * For ANY sequence of events, modifying an event's payload field
   * (which changes the hash input) MUST cause chain verification to fail.
   */
  it('modifying any event payload breaks chain verification', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validIngestRequestArb, { minLength: 2, maxLength: 10 }),
        fc.nat(),
        async (requests, tamperSeed) => {
          const localStore = new InMemoryAuditEventStore();
          const localService = new AuditIngestionService(localStore, hasher, signer);

          for (const request of requests) {
            await localService.ingest(request, ctx);
          }

          // Pick an event to tamper with
          const tamperIndex = tamperSeed % requests.length;

          // Get all events and tamper with one's payload (but keep chain_hash unchanged)
          const events = await localStore.getRange('tenant-1', 1, requests.length);
          const tamperedStore = new InMemoryAuditEventStore();

          for (let i = 0; i < events.length; i++) {
            if (i === tamperIndex) {
              // Modify the outcome field (part of hash input) but keep chain_hash the same
              const tamperedEvent = {
                ...events[i]!,
                outcome: events[i]!.outcome + '_TAMPERED',
              };
              await tamperedStore.append(tamperedEvent);
            } else {
              await tamperedStore.append(events[i]!);
            }
          }

          // Verify with tampered store — should detect mismatch
          const tamperedService = new AuditIngestionService(tamperedStore, hasher, signer);
          const result = await tamperedService.verifyChain(
            { tenant_id: 'tenant-1' },
            ctx,
          );

          expect(result.valid).toBe(false);
          const hashMismatches = result.violations.filter((v) => v.type === 'HASH_MISMATCH');
          expect(hashMismatches.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 6: Audit Event Completeness ────────────────────────────────────

describe('Property 6: Audit Event Completeness', () => {
  let store: InMemoryAuditEventStore;
  let hasher: SHA256ChainHasher;
  let signer: HMACChainSigner;
  let service: AuditIngestionService;
  let ctx: RequestContext;

  beforeEach(() => {
    store = new InMemoryAuditEventStore();
    hasher = new SHA256ChainHasher();
    signer = new HMACChainSigner(new StubSigningKeyProvider());
    service = new AuditIngestionService(store, hasher, signer);
    ctx = createTestContext();
  });

  /** Required fields that must be present and non-empty. */
  const REQUIRED_FIELDS: (keyof IngestRequest)[] = [
    'timestamp',
    'tenant_id',
    'principal_id',
    'source_service',
    'event_category',
    'severity',
    'correlation_id',
    'outcome',
  ];

  /**
   * **Validates: Requirements 21.7**
   *
   * For ANY IngestRequest where one or more required fields are empty strings,
   * the service MUST reject with a VALIDATION error (category = 'VALIDATION').
   */
  it('rejects events with any empty required field with VALIDATION error', async () => {
    // Generate a valid request and then blank out one required field
    const fieldToBlankArb = fc.constantFrom(...REQUIRED_FIELDS.filter((f) => f !== 'severity'));

    await fc.assert(
      fc.asyncProperty(
        validIngestRequestArb,
        fieldToBlankArb,
        async (baseRequest, fieldToBlank) => {
          const invalidRequest = {
            ...baseRequest,
            [fieldToBlank]: '',
          } as IngestRequest;

          try {
            await service.ingest(invalidRequest, ctx);
            // Should not reach here
            expect.fail('Expected VALIDATION error to be thrown');
          } catch (err: unknown) {
            const error = err as { category: string; code: string };
            expect(error.category).toBe('VALIDATION');
            expect(error.code).toBe('MISSING_REQUIRED_FIELD');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 21.7**
   *
   * For ANY IngestRequest with an invalid severity value (not in the valid set),
   * the service MUST reject with a VALIDATION error.
   */
  it('rejects events with invalid severity value with VALIDATION error', async () => {
    const invalidSeverityArb = nonEmptyStringArb.filter(
      (s) => !VALID_SEVERITIES.includes(s as AuditSeverity),
    );

    await fc.assert(
      fc.asyncProperty(
        validIngestRequestArb,
        invalidSeverityArb,
        async (baseRequest, invalidSeverity) => {
          const invalidRequest = {
            ...baseRequest,
            severity: invalidSeverity as AuditSeverity,
          };

          try {
            await service.ingest(invalidRequest, ctx);
            expect.fail('Expected VALIDATION error to be thrown');
          } catch (err: unknown) {
            const error = err as { category: string; code: string };
            expect(error.category).toBe('VALIDATION');
            expect(error.code).toBe('MISSING_REQUIRED_FIELD');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 21.7**
   *
   * For ANY valid IngestRequest (all required fields present and non-empty,
   * severity in valid set), the service MUST accept the event without error
   * and return an AuditAck with event_id, sequence_number, and chain_hash.
   */
  it('accepts events with all required fields present and non-empty', async () => {
    await fc.assert(
      fc.asyncProperty(validIngestRequestArb, async (request) => {
        const localStore = new InMemoryAuditEventStore();
        const localService = new AuditIngestionService(localStore, hasher, signer);

        const ack = await localService.ingest(request, ctx);

        // Ack must contain all required response fields
        expect(ack.event_id).toBeDefined();
        expect(ack.event_id.length).toBeGreaterThan(0);
        expect(ack.sequence_number).toBeGreaterThanOrEqual(1);
        expect(ack.chain_hash).toBeDefined();
        expect(ack.chain_hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 21.7**
   *
   * For ANY valid IngestRequest, the persisted event MUST contain all
   * required fields with non-empty values.
   */
  it('persisted events contain all required fields with non-empty values', async () => {
    await fc.assert(
      fc.asyncProperty(validIngestRequestArb, async (request) => {
        const localStore = new InMemoryAuditEventStore();
        const localService = new AuditIngestionService(localStore, hasher, signer);

        await localService.ingest(request, ctx);

        const storedEvent = await localStore.getLastEvent('tenant-1');
        expect(storedEvent).not.toBeNull();

        // All required fields must be present and non-empty
        expect(storedEvent!.event_id).toBeDefined();
        expect(storedEvent!.event_id.length).toBeGreaterThan(0);
        expect(storedEvent!.sequence_number).toBeGreaterThanOrEqual(1);
        expect(storedEvent!.chain_hash).toBeDefined();
        expect(storedEvent!.chain_hash.length).toBeGreaterThan(0);
        expect(storedEvent!.timestamp).toBeDefined();
        expect(storedEvent!.timestamp.length).toBeGreaterThan(0);
        expect(storedEvent!.tenant_id).toBeDefined();
        expect(storedEvent!.tenant_id.length).toBeGreaterThan(0);
        expect(storedEvent!.principal_id).toBeDefined();
        expect(storedEvent!.principal_id.length).toBeGreaterThan(0);
        expect(storedEvent!.source_service).toBeDefined();
        expect(storedEvent!.source_service.length).toBeGreaterThan(0);
        expect(storedEvent!.event_category).toBeDefined();
        expect(storedEvent!.event_category.length).toBeGreaterThan(0);
        expect(storedEvent!.severity).toBeDefined();
        expect(VALID_SEVERITIES).toContain(storedEvent!.severity);
        expect(storedEvent!.correlation_id).toBeDefined();
        expect(storedEvent!.correlation_id.length).toBeGreaterThan(0);
        expect(storedEvent!.outcome).toBeDefined();
        expect(storedEvent!.outcome.length).toBeGreaterThan(0);
        expect(storedEvent!.payload).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });
});
