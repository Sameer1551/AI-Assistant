/**
 * Unit tests for AuditIngestionService.
 *
 * Verifies:
 * - Required field validation
 * - Monotonically increasing sequence numbers per tenant
 * - SHA-256 chain hash integrity
 * - Chain segment signing
 * - Tenant isolation
 * - Chain verification
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { AuditIngestionService } from '../src/audit-ingestion-service.js';
import { SHA256ChainHasher } from '../src/sha256-chain-hasher.js';
import { HMACChainSigner } from '../src/chain-signer.js';
import { InMemoryAuditEventStore } from '../src/in-memory-audit-event-store.js';
import type { ISigningKeyProvider } from '../src/chain-signer.js';
import type { IngestRequest } from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Stub signing key provider that returns a fixed key per tenant. */
class StubSigningKeyProvider implements ISigningKeyProvider {
  private readonly keys: Map<string, string> = new Map();

  constructor() {
    // Pre-populate with a default key (base64-encoded)
    this.keys.set('tenant-1', Buffer.from('test-signing-key-tenant-1').toString('base64'));
    this.keys.set('tenant-2', Buffer.from('test-signing-key-tenant-2').toString('base64'));
  }

  async getSigningKey(tenantId: string): Promise<string> {
    const key = this.keys.get(tenantId);
    if (!key) {
      // Generate a key for unknown tenants
      const newKey = Buffer.from(`test-signing-key-${tenantId}`).toString('base64');
      this.keys.set(tenantId, newKey);
      return newKey;
    }
    return key;
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

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('AuditIngestionService', () => {
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

  // ─── Field Validation ────────────────────────────────────────────────────

  describe('field validation', () => {
    it('should reject request with missing timestamp', async () => {
      const request = createValidRequest({ timestamp: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
        code: 'MISSING_REQUIRED_FIELD',
      });
    });

    it('should reject request with missing tenant_id', async () => {
      const request = createValidRequest({ tenant_id: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with missing principal_id', async () => {
      const request = createValidRequest({ principal_id: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with missing source_service', async () => {
      const request = createValidRequest({ source_service: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with missing event_category', async () => {
      const request = createValidRequest({ event_category: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with missing correlation_id', async () => {
      const request = createValidRequest({ correlation_id: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with missing outcome', async () => {
      const request = createValidRequest({ outcome: '' });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with invalid severity', async () => {
      const request = createValidRequest({ severity: 'INVALID' as never });
      await expect(service.ingest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should include missing field names in error details', async () => {
      const request = createValidRequest({ timestamp: '', outcome: '' });
      try {
        await service.ingest(request, ctx);
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as { details: { missing_fields: string[] } };
        expect(error.details.missing_fields).toContain('timestamp');
        expect(error.details.missing_fields).toContain('outcome');
      }
    });

    it('should accept request with all valid fields', async () => {
      const request = createValidRequest();
      const ack = await service.ingest(request, ctx);
      expect(ack.event_id).toBeDefined();
      expect(ack.sequence_number).toBe(1);
      expect(ack.chain_hash).toBeDefined();
    });
  });

  // ─── Sequence Numbers ────────────────────────────────────────────────────

  describe('sequence numbers', () => {
    it('should assign sequence_number 1 to the first event', async () => {
      const ack = await service.ingest(createValidRequest(), ctx);
      expect(ack.sequence_number).toBe(1);
    });

    it('should assign monotonically increasing sequence numbers', async () => {
      const ack1 = await service.ingest(createValidRequest(), ctx);
      const ack2 = await service.ingest(createValidRequest(), ctx);
      const ack3 = await service.ingest(createValidRequest(), ctx);

      expect(ack1.sequence_number).toBe(1);
      expect(ack2.sequence_number).toBe(2);
      expect(ack3.sequence_number).toBe(3);
    });

    it('should maintain independent sequence numbers per tenant', async () => {
      const ctx2 = createTestContext('tenant-2');
      const request1 = createValidRequest({ tenant_id: 'tenant-1' });
      const request2 = createValidRequest({ tenant_id: 'tenant-2' });

      const ack1 = await service.ingest(request1, ctx);
      const ack2 = await service.ingest(request2, ctx2);
      const ack3 = await service.ingest(request1, ctx);

      expect(ack1.sequence_number).toBe(1);
      expect(ack2.sequence_number).toBe(1); // Independent chain
      expect(ack3.sequence_number).toBe(2);
    });

    it('should handle concurrent ingestion without gaps', async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        service.ingest(
          createValidRequest({ outcome: `SUCCESS_${i}` }),
          ctx,
        ),
      );

      const acks = await Promise.all(requests);
      const sequences = acks.map((a) => a.sequence_number).sort((a, b) => a - b);

      // Should be 1, 2, 3, ..., 10 with no gaps
      for (let i = 0; i < sequences.length; i++) {
        expect(sequences[i]).toBe(i + 1);
      }
    });
  });

  // ─── Chain Hash Integrity ────────────────────────────────────────────────

  describe('chain hash integrity', () => {
    it('should compute genesis hash for first event', async () => {
      const ack = await service.ingest(createValidRequest(), ctx);
      expect(ack.chain_hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should produce different hashes for different events', async () => {
      const ack1 = await service.ingest(
        createValidRequest({ outcome: 'SUCCESS' }),
        ctx,
      );
      const ack2 = await service.ingest(
        createValidRequest({ outcome: 'FAILURE' }),
        ctx,
      );

      expect(ack1.chain_hash).not.toBe(ack2.chain_hash);
    });

    it('should link each event to the previous via chain hash', async () => {
      await service.ingest(createValidRequest(), ctx);
      await service.ingest(createValidRequest(), ctx);
      await service.ingest(createValidRequest(), ctx);

      // Verify the chain is valid
      const result = await service.verifyChain(
        { tenant_id: 'tenant-1' },
        ctx,
      );
      expect(result.valid).toBe(true);
      expect(result.events_verified).toBe(3);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect tampered events via chain verification', async () => {
      // Ingest 3 events
      await service.ingest(createValidRequest(), ctx);
      await service.ingest(createValidRequest(), ctx);
      await service.ingest(createValidRequest(), ctx);

      // Tamper with the store directly (simulate modification)
      const events = await store.getRange('tenant-1', 1, 3);
      const tamperedEvent = { ...events[1]!, chain_hash: 'tampered-hash-value' };

      // Create a new store with tampered data
      const tamperedStore = new InMemoryAuditEventStore();
      await tamperedStore.append(events[0]!);
      await tamperedStore.append(tamperedEvent);
      await tamperedStore.append(events[2]!);

      const tamperedService = new AuditIngestionService(
        tamperedStore,
        hasher,
        signer,
      );

      const result = await tamperedService.verifyChain(
        { tenant_id: 'tenant-1' },
        ctx,
      );
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.some((v) => v.type === 'HASH_MISMATCH')).toBe(true);
    });
  });

  // ─── Chain Signing ───────────────────────────────────────────────────────

  describe('chain signing', () => {
    it('should sign each event with a signature', async () => {
      await service.ingest(createValidRequest(), ctx);

      const result = await store.getLastEvent('tenant-1');
      expect(result).not.toBeNull();
      expect(result!.signature).toBeDefined();
      expect(result!.signature).toMatch(/^[a-f0-9]+$/); // Hex-encoded
    });

    it('should produce different signatures for different tenants', async () => {
      const ctx2 = createTestContext('tenant-2');

      await service.ingest(createValidRequest({ tenant_id: 'tenant-1' }), ctx);
      await service.ingest(createValidRequest({ tenant_id: 'tenant-2' }), ctx2);

      const event1 = await store.getLastEvent('tenant-1');
      const event2 = await store.getLastEvent('tenant-2');

      expect(event1!.signature).not.toBe(event2!.signature);
    });
  });

  // ─── Query ───────────────────────────────────────────────────────────────

  describe('query', () => {
    it('should return events for the authenticated tenant', async () => {
      await service.ingest(createValidRequest(), ctx);
      await service.ingest(createValidRequest(), ctx);

      const result = await service.query({ tenant_id: 'tenant-1' }, ctx);
      expect(result.events).toHaveLength(2);
      expect(result.total_count).toBe(2);
    });

    it('should enforce tenant scoping from context', async () => {
      await service.ingest(createValidRequest({ tenant_id: 'tenant-1' }), ctx);

      const ctx2 = createTestContext('tenant-2');
      // Query with tenant-2 context should not see tenant-1 events
      const result = await service.query({ tenant_id: 'tenant-2' }, ctx2);
      expect(result.events).toHaveLength(0);
    });
  });

  // ─── Payload Handling ────────────────────────────────────────────────────

  describe('payload handling', () => {
    it('should default payload to empty object when not provided', async () => {
      const request = createValidRequest();
      delete (request as Record<string, unknown>)['payload'];

      await service.ingest(request, ctx);
      const event = await store.getLastEvent('tenant-1');
      expect(event!.payload).toEqual({});
    });

    it('should preserve payload data in stored event', async () => {
      const payload = { action_id: 'act-1', risk_level: 'HIGH' };
      await service.ingest(createValidRequest({ payload }), ctx);

      const event = await store.getLastEvent('tenant-1');
      expect(event!.payload).toEqual(payload);
    });
  });
});
