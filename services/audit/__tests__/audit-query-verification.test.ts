/**
 * Unit tests for audit query filtering, chain verification, and retention enforcement.
 *
 * Validates:
 * - Query RPC with tenant-scoped filtering (time range, source_service, event_category, severity, correlation_id)
 * - VerifyChain RPC detecting insertion, deletion, and modification
 * - Retention enforcement (≥365 days minimum)
 *
 * @see Requirement 21.3 - Verification interface
 * @see Requirement 21.4 - Retention enforcement
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext, AuditEvent } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { AuditIngestionService } from '../src/audit-ingestion-service.js';
import { SHA256ChainHasher } from '../src/sha256-chain-hasher.js';
import { HMACChainSigner } from '../src/chain-signer.js';
import { InMemoryAuditEventStore } from '../src/in-memory-audit-event-store.js';
import type { ISigningKeyProvider } from '../src/chain-signer.js';
import type { IngestRequest } from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

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

function createValidRequest(overrides: Partial<IngestRequest> = {}): IngestRequest {
  return {
    timestamp: '2024-01-15T10:30:00.000Z',
    tenant_id: 'tenant-1',
    principal_id: 'principal-1',
    source_service: 'Control_Service',
    event_category: 'action.executed',
    severity: 'INFO',
    correlation_id: 'corr-123',
    outcome: 'SUCCESS',
    payload: { action_id: 'act-1' },
    ...overrides,
  };
}

// ─── Test Suite: Query Filtering ─────────────────────────────────────────────

describe('AuditIngestionService - Query Filtering', () => {
  let store: InMemoryAuditEventStore;
  let hasher: SHA256ChainHasher;
  let signer: HMACChainSigner;
  let service: AuditIngestionService;
  let ctx: RequestContext;

  beforeEach(async () => {
    store = new InMemoryAuditEventStore();
    hasher = new SHA256ChainHasher();
    signer = new HMACChainSigner(new StubSigningKeyProvider());
    service = new AuditIngestionService(store, hasher, signer);
    ctx = createTestContext();

    // Seed events with varied attributes for filtering tests
    await service.ingest(createValidRequest({
      timestamp: '2024-01-10T08:00:00.000Z',
      source_service: 'Control_Service',
      event_category: 'action.executed',
      severity: 'INFO',
      correlation_id: 'corr-aaa',
    }), ctx);
    await service.ingest(createValidRequest({
      timestamp: '2024-01-12T12:00:00.000Z',
      source_service: 'Identity_Service',
      event_category: 'auth.decision',
      severity: 'HIGH',
      correlation_id: 'corr-bbb',
    }), ctx);

    await service.ingest(createValidRequest({
      timestamp: '2024-01-15T10:30:00.000Z',
      source_service: 'LLM_Gateway',
      event_category: 'model.invocation',
      severity: 'MEDIUM',
      correlation_id: 'corr-ccc',
    }), ctx);

    await service.ingest(createValidRequest({
      timestamp: '2024-01-18T16:00:00.000Z',
      source_service: 'Control_Service',
      event_category: 'action.executed',
      severity: 'CRITICAL',
      correlation_id: 'corr-ddd',
    }), ctx);

    await service.ingest(createValidRequest({
      timestamp: '2024-01-20T09:00:00.000Z',
      source_service: 'Memory_Service',
      event_category: 'memory.write',
      severity: 'LOW',
      correlation_id: 'corr-aaa',
    }), ctx);
  });

  describe('tenant-scoped filtering', () => {
    it('should only return events for the authenticated tenant', async () => {
      // Ingest an event for tenant-2
      const ctx2 = createTestContext('tenant-2');
      await service.ingest(createValidRequest({ tenant_id: 'tenant-2' }), ctx2);

      // Query as tenant-1 should not see tenant-2 events
      const result = await service.query({ tenant_id: 'tenant-1' }, ctx);
      expect(result.events.every(e => e.tenant_id === 'tenant-1')).toBe(true);
      expect(result.total_count).toBe(5);
    });

    it('should override query tenant_id with authenticated context tenant_id', async () => {
      // Even if query specifies a different tenant_id, the context tenant is used
      const result = await service.query({ tenant_id: 'tenant-2' }, ctx);
      // ctx is tenant-1, so it should return tenant-1 events
      expect(result.events.every(e => e.tenant_id === 'tenant-1')).toBe(true);
      expect(result.total_count).toBe(5);
    });
  });

  describe('time range filtering', () => {
    it('should filter events by from_timestamp', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        from_timestamp: '2024-01-15T00:00:00.000Z',
      }, ctx);
      expect(result.total_count).toBe(3);
      expect(result.events.every(e => e.timestamp >= '2024-01-15T00:00:00.000Z')).toBe(true);
    });

    it('should filter events by to_timestamp', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        to_timestamp: '2024-01-14T00:00:00.000Z',
      }, ctx);
      expect(result.total_count).toBe(2);
      expect(result.events.every(e => e.timestamp <= '2024-01-14T00:00:00.000Z')).toBe(true);
    });

    it('should filter events by both from_timestamp and to_timestamp', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        from_timestamp: '2024-01-12T00:00:00.000Z',
        to_timestamp: '2024-01-16T00:00:00.000Z',
      }, ctx);
      expect(result.total_count).toBe(2);
    });

    it('should return empty when time range matches no events', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        from_timestamp: '2025-01-01T00:00:00.000Z',
      }, ctx);
      expect(result.total_count).toBe(0);
      expect(result.events).toHaveLength(0);
    });
  });

  describe('source_service filtering', () => {
    it('should filter events by source_service', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        source_service: 'Control_Service',
      }, ctx);
      expect(result.total_count).toBe(2);
      expect(result.events.every(e => e.source_service === 'Control_Service')).toBe(true);
    });

    it('should return empty for non-existent source_service', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        source_service: 'NonExistent_Service',
      }, ctx);
      expect(result.total_count).toBe(0);
    });
  });

  describe('event_category filtering', () => {
    it('should filter events by event_category', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        event_category: 'action.executed',
      }, ctx);
      expect(result.total_count).toBe(2);
      expect(result.events.every(e => e.event_category === 'action.executed')).toBe(true);
    });

    it('should filter by single event_category value', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        event_category: 'auth.decision',
      }, ctx);
      expect(result.total_count).toBe(1);
      expect(result.events[0]!.source_service).toBe('Identity_Service');
    });
  });

  describe('severity filtering', () => {
    it('should filter events by severity', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        severity: 'HIGH',
      }, ctx);
      expect(result.total_count).toBe(1);
      expect(result.events[0]!.severity).toBe('HIGH');
    });

    it('should filter CRITICAL severity events', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        severity: 'CRITICAL',
      }, ctx);
      expect(result.total_count).toBe(1);
      expect(result.events[0]!.source_service).toBe('Control_Service');
    });
  });

  describe('correlation_id filtering', () => {
    it('should filter events by correlation_id', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        correlation_id: 'corr-aaa',
      }, ctx);
      expect(result.total_count).toBe(2);
      expect(result.events.every(e => e.correlation_id === 'corr-aaa')).toBe(true);
    });

    it('should return single event for unique correlation_id', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        correlation_id: 'corr-bbb',
      }, ctx);
      expect(result.total_count).toBe(1);
      expect(result.events[0]!.event_category).toBe('auth.decision');
    });
  });

  describe('combined filters', () => {
    it('should apply multiple filters simultaneously', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        source_service: 'Control_Service',
        event_category: 'action.executed',
        severity: 'CRITICAL',
      }, ctx);
      expect(result.total_count).toBe(1);
      expect(result.events[0]!.timestamp).toBe('2024-01-18T16:00:00.000Z');
    });

    it('should return empty when combined filters match nothing', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        source_service: 'Control_Service',
        severity: 'LOW',
      }, ctx);
      expect(result.total_count).toBe(0);
    });
  });

  describe('pagination', () => {
    it('should respect limit parameter', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        limit: 2,
      }, ctx);
      expect(result.events).toHaveLength(2);
      expect(result.total_count).toBe(5);
    });

    it('should respect offset parameter', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        limit: 2,
        offset: 3,
      }, ctx);
      expect(result.events).toHaveLength(2);
      expect(result.total_count).toBe(5);
    });

    it('should return empty events when offset exceeds total', async () => {
      const result = await service.query({
        tenant_id: 'tenant-1',
        offset: 100,
      }, ctx);
      expect(result.events).toHaveLength(0);
      expect(result.total_count).toBe(5);
    });
  });

  describe('empty tenant', () => {
    it('should return empty result for tenant with no events', async () => {
      const ctx3 = createTestContext('tenant-empty');
      const result = await service.query({ tenant_id: 'tenant-empty' }, ctx3);
      expect(result.events).toHaveLength(0);
      expect(result.total_count).toBe(0);
    });
  });
});

// ─── Test Suite: Chain Verification ──────────────────────────────────────────

describe('AuditIngestionService - Chain Verification', () => {
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

  describe('valid chain', () => {
    it('should verify an empty chain as valid', async () => {
      const result = await service.verifyChain({ tenant_id: 'tenant-1' }, ctx);
      expect(result.valid).toBe(true);
      expect(result.events_verified).toBe(0);
      expect(result.violations).toHaveLength(0);
    });

    it('should verify a single-event chain as valid', async () => {
      await service.ingest(createValidRequest(), ctx);
      const result = await service.verifyChain({ tenant_id: 'tenant-1' }, ctx);
      expect(result.valid).toBe(true);
      expect(result.events_verified).toBe(1);
      expect(result.violations).toHaveLength(0);
    });

    it('should verify a multi-event chain as valid', async () => {
      for (let i = 0; i < 10; i++) {
        await service.ingest(createValidRequest({ outcome: `SUCCESS_${i}` }), ctx);
      }
      const result = await service.verifyChain({ tenant_id: 'tenant-1' }, ctx);
      expect(result.valid).toBe(true);
      expect(result.events_verified).toBe(10);
      expect(result.violations).toHaveLength(0);
    });

    it('should verify a partial range of the chain', async () => {
      for (let i = 0; i < 5; i++) {
        await service.ingest(createValidRequest({ outcome: `SUCCESS_${i}` }), ctx);
      }
      const result = await service.verifyChain({
        tenant_id: 'tenant-1',
        from_sequence: 2,
        to_sequence: 4,
      }, ctx);
      expect(result.valid).toBe(true);
      expect(result.events_verified).toBe(3);
    });
  });

  describe('detecting hash mismatches (modification)', () => {
    it('should detect a modified event via hash mismatch', async () => {
      await service.ingest(createValidRequest({ outcome: 'SUCCESS' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'FAILURE' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'SUCCESS' }), ctx);

      // Tamper with the middle event
      const events = await store.getRange('tenant-1', 1, 3);
      const tampered = { ...events[1]!, chain_hash: 'aaaa'.repeat(16) };

      const tamperedStore = new InMemoryAuditEventStore();
      await tamperedStore.append(events[0]!);
      await tamperedStore.append(tampered);
      await tamperedStore.append(events[2]!);

      const tamperedService = new AuditIngestionService(tamperedStore, hasher, signer);
      const result = await tamperedService.verifyChain({ tenant_id: 'tenant-1' }, ctx);

      expect(result.valid).toBe(false);
      expect(result.violations.some(v => v.type === 'HASH_MISMATCH')).toBe(true);
    });

    it('should detect modification of the first event', async () => {
      await service.ingest(createValidRequest({ outcome: 'SUCCESS' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'FAILURE' }), ctx);

      const events = await store.getRange('tenant-1', 1, 2);
      const tampered = { ...events[0]!, chain_hash: 'bbbb'.repeat(16) };

      const tamperedStore = new InMemoryAuditEventStore();
      await tamperedStore.append(tampered);
      await tamperedStore.append(events[1]!);

      const tamperedService = new AuditIngestionService(tamperedStore, hasher, signer);
      const result = await tamperedService.verifyChain({ tenant_id: 'tenant-1' }, ctx);

      expect(result.valid).toBe(false);
      expect(result.violations.some(v => v.type === 'HASH_MISMATCH')).toBe(true);
    });

    it('should detect payload modification via hash mismatch', async () => {
      await service.ingest(createValidRequest({ payload: { key: 'original' } }), ctx);
      await service.ingest(createValidRequest({ outcome: 'NEXT' }), ctx);

      const events = await store.getRange('tenant-1', 1, 2);
      // Modify payload but keep the same chain_hash (simulating tampering)
      const tampered = { ...events[0]!, payload: { key: 'modified' } };

      const tamperedStore = new InMemoryAuditEventStore();
      await tamperedStore.append(tampered);
      await tamperedStore.append(events[1]!);

      const tamperedService = new AuditIngestionService(tamperedStore, hasher, signer);
      const result = await tamperedService.verifyChain({ tenant_id: 'tenant-1' }, ctx);

      // The hash of event 2 depends on event 1's chain_hash, which is still correct
      // But if we recompute event 1's hash with modified payload, it won't match stored hash
      expect(result.valid).toBe(false);
    });
  });

  describe('detecting sequence gaps (deletion)', () => {
    it('should detect a gap when an event is deleted from the middle', async () => {
      await service.ingest(createValidRequest({ outcome: 'A' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'B' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'C' }), ctx);

      // Remove the middle event (simulate deletion)
      const events = await store.getRange('tenant-1', 1, 3);
      const gappedStore = new InMemoryAuditEventStore();
      await gappedStore.append(events[0]!);
      // Skip events[1] - simulating deletion
      await gappedStore.append(events[2]!);

      const gappedService = new AuditIngestionService(gappedStore, hasher, signer);
      const result = await gappedService.verifyChain({ tenant_id: 'tenant-1' }, ctx);

      expect(result.valid).toBe(false);
      const gapViolation = result.violations.find(v => v.type === 'SEQUENCE_GAP');
      expect(gapViolation).toBeDefined();
      expect(gapViolation!.at_sequence).toBe(2);
    });

    it('should detect missing events at the end of range', async () => {
      await service.ingest(createValidRequest({ outcome: 'A' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'B' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'C' }), ctx);

      // Create store with only first event but verify range 1-3
      const partialStore = new InMemoryAuditEventStore();
      const events = await store.getRange('tenant-1', 1, 3);
      await partialStore.append(events[0]!);

      // Manually add event 3 to simulate gap (missing event 2)
      await partialStore.append(events[2]!);

      const partialService = new AuditIngestionService(partialStore, hasher, signer);
      const result = await partialService.verifyChain({
        tenant_id: 'tenant-1',
        from_sequence: 1,
        to_sequence: 3,
      }, ctx);

      expect(result.valid).toBe(false);
      expect(result.violations.some(v => v.type === 'MISSING_EVENT' || v.type === 'SEQUENCE_GAP')).toBe(true);
    });
  });

  describe('detecting insertion', () => {
    it('should detect an inserted event via hash chain break', async () => {
      await service.ingest(createValidRequest({ outcome: 'A' }), ctx);
      await service.ingest(createValidRequest({ outcome: 'C' }), ctx);

      const events = await store.getRange('tenant-1', 1, 2);

      // Insert a fake event between them
      const fakeEvent: AuditEvent = {
        event_id: 'fake-event-id',
        sequence_number: 2,
        chain_hash: 'fake-hash-value-' + '0'.repeat(48),
        timestamp: '2024-01-15T10:31:00.000Z',
        tenant_id: 'tenant-1',
        principal_id: 'principal-1',
        source_service: 'Fake_Service',
        event_category: 'fake.event',
        severity: 'INFO',
        correlation_id: 'corr-fake',
        outcome: 'SUCCESS',
        payload: {},
        signature: 'fake-signature',
      };

      // Renumber original event 2 to 3
      const renumbered = { ...events[1]!, sequence_number: 3 };

      const insertedStore = new InMemoryAuditEventStore();
      await insertedStore.append(events[0]!);
      await insertedStore.append(fakeEvent);
      await insertedStore.append(renumbered);

      const insertedService = new AuditIngestionService(insertedStore, hasher, signer);
      const result = await insertedService.verifyChain({ tenant_id: 'tenant-1' }, ctx);

      expect(result.valid).toBe(false);
      expect(result.violations.some(v => v.type === 'HASH_MISMATCH')).toBe(true);
    });
  });

  describe('tenant isolation in verification', () => {
    it('should verify chains independently per tenant', async () => {
      const ctx2 = createTestContext('tenant-2');

      await service.ingest(createValidRequest({ tenant_id: 'tenant-1' }), ctx);
      await service.ingest(createValidRequest({ tenant_id: 'tenant-2' }), ctx2);
      await service.ingest(createValidRequest({ tenant_id: 'tenant-1' }), ctx);

      const result1 = await service.verifyChain({ tenant_id: 'tenant-1' }, ctx);
      const result2 = await service.verifyChain({ tenant_id: 'tenant-2' }, ctx2);

      expect(result1.valid).toBe(true);
      expect(result1.events_verified).toBe(2);
      expect(result2.valid).toBe(true);
      expect(result2.events_verified).toBe(1);
    });
  });
});

// ─── Test Suite: Retention Enforcement ───────────────────────────────────────

describe('AuditIngestionService - Retention Enforcement', () => {
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

  describe('minimum retention enforcement', () => {
    it('should enforce minimum 365 days even when lower value is requested', async () => {
      // Ingest an event with a recent timestamp
      const recentTimestamp = new Date().toISOString();
      await service.ingest(createValidRequest({ timestamp: recentTimestamp }), ctx);

      // Try to enforce 30-day retention (should be clamped to 365)
      const result = await service.enforceRetention('tenant-1', 30);

      // Recent event should NOT be deleted (it's within 365 days)
      expect(result.events_deleted).toBe(0);
      expect(result.tenant_id).toBe('tenant-1');
    });

    it('should enforce minimum 365 days when 0 is requested', async () => {
      const recentTimestamp = new Date().toISOString();
      await service.ingest(createValidRequest({ timestamp: recentTimestamp }), ctx);

      const result = await service.enforceRetention('tenant-1', 0);
      expect(result.events_deleted).toBe(0);
    });

    it('should enforce minimum 365 days when negative value is requested', async () => {
      const recentTimestamp = new Date().toISOString();
      await service.ingest(createValidRequest({ timestamp: recentTimestamp }), ctx);

      const result = await service.enforceRetention('tenant-1', -100);
      expect(result.events_deleted).toBe(0);
    });

    it('should use tenant-configured retention when greater than 365', async () => {
      // Event from 400 days ago
      const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      await service.ingest(createValidRequest({ timestamp: oldDate.toISOString() }), ctx);

      // With 365-day retention, this event should be deleted
      const result365 = await service.enforceRetention('tenant-1', 365);
      expect(result365.events_deleted).toBe(1);
    });

    it('should preserve events within retention period when using longer retention', async () => {
      // Event from 400 days ago
      const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      await service.ingest(createValidRequest({ timestamp: oldDate.toISOString() }), ctx);

      // With 500-day retention, this event should NOT be deleted
      const result500 = await service.enforceRetention('tenant-1', 500);
      expect(result500.events_deleted).toBe(0);
    });
  });

  describe('deletion behavior', () => {
    it('should delete events older than retention period', async () => {
      // Event from 2 years ago
      const veryOldDate = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
      await service.ingest(createValidRequest({ timestamp: veryOldDate.toISOString() }), ctx);

      // Recent event
      const recentTimestamp = new Date().toISOString();
      await service.ingest(createValidRequest({ timestamp: recentTimestamp }), ctx);

      const result = await service.enforceRetention('tenant-1', 365);
      expect(result.events_deleted).toBe(1);
      expect(result.events_marked).toBe(1);

      // Verify only the recent event remains
      const queryResult = await service.query({ tenant_id: 'tenant-1' }, ctx);
      expect(queryResult.total_count).toBe(1);
    });

    it('should delete multiple old events', async () => {
      // 3 events from 2 years ago
      const veryOldDate = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 3; i++) {
        await service.ingest(createValidRequest({
          timestamp: new Date(veryOldDate.getTime() + i * 1000).toISOString(),
        }), ctx);
      }

      // 2 recent events
      for (let i = 0; i < 2; i++) {
        await service.ingest(createValidRequest({
          timestamp: new Date().toISOString(),
        }), ctx);
      }

      const result = await service.enforceRetention('tenant-1', 365);
      expect(result.events_deleted).toBe(3);
    });

    it('should return zero deletions for empty tenant', async () => {
      const result = await service.enforceRetention('tenant-empty', 365);
      expect(result.events_deleted).toBe(0);
      expect(result.events_marked).toBe(0);
      expect(result.tenant_id).toBe('tenant-empty');
    });

    it('should return a valid cutoff_timestamp in ISO format', async () => {
      const result = await service.enforceRetention('tenant-1', 365);
      expect(result.cutoff_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Cutoff should be approximately 365 days ago
      const cutoff = new Date(result.cutoff_timestamp);
      const expectedCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      // Allow 5 seconds tolerance for test execution time
      expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(5000);
    });
  });

  describe('tenant isolation in retention', () => {
    it('should only delete events for the specified tenant', async () => {
      const ctx2 = createTestContext('tenant-2');
      const veryOldDate = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);

      // Old events for both tenants
      await service.ingest(createValidRequest({
        tenant_id: 'tenant-1',
        timestamp: veryOldDate.toISOString(),
      }), ctx);
      await service.ingest(createValidRequest({
        tenant_id: 'tenant-2',
        timestamp: veryOldDate.toISOString(),
      }), ctx2);

      // Enforce retention only for tenant-1
      await service.enforceRetention('tenant-1', 365);

      // tenant-1 should have no events
      const result1 = await service.query({ tenant_id: 'tenant-1' }, ctx);
      expect(result1.total_count).toBe(0);

      // tenant-2 should still have its event
      const result2 = await service.query({ tenant_id: 'tenant-2' }, ctx2);
      expect(result2.total_count).toBe(1);
    });
  });
});
