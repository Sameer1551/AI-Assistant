/**
 * Unit tests for RetentionEnforcer.
 *
 * Verifies:
 * - Records exceeding retention duration are marked for deletion
 * - Component-specific rules take priority over classification-level rules
 * - Regulated data uses cryptographic shredding
 * - Non-regulated data uses irreversible deletion
 * - Deletion deadline is within 24 hours of enforcement
 * - Records not yet expired are not marked
 * - Tenant isolation (records from other tenants are skipped)
 *
 * @see Requirement 25.2 - Retention rules per classification and per component
 * @see Requirement 25.3 - Irreversible deletion/shredding within 24h of expiry
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RetentionEnforcer } from '../src/retention-enforcer.js';
import { InMemoryTenantTaxonomyStore } from '../src/in-memory-tenant-taxonomy-store.js';
import type { RetentionRecord } from '../src/interfaces/classification-service.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createRecord(overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  return {
    record_id: 'record-1',
    tenant_id: 'tenant-1',
    classification: 'internal',
    component: 'Memory_Service',
    created_at: '2024-01-01T00:00:00.000Z',
    expires_at: '2024-04-01T00:00:00.000Z', // 90 days
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('RetentionEnforcer', () => {
  let store: InMemoryTenantTaxonomyStore;
  let enforcer: RetentionEnforcer;

  beforeEach(() => {
    store = new InMemoryTenantTaxonomyStore();
    enforcer = new RetentionEnforcer(store);

    // Configure tenant with retention rules
    store.configure('tenant-1', {
      classifications: [
        'public',
        'internal',
        'confidential',
        'restricted',
        'regulated_pii',
        'regulated_health',
        'regulated_financial',
      ],
      retentionRules: [
        { classification: 'public', retention_days: 365 },
        { classification: 'internal', retention_days: 90 },
        { classification: 'confidential', retention_days: 180 },
        { classification: 'restricted', retention_days: 30 },
        { classification: 'regulated_pii', retention_days: 730 },
        { classification: 'regulated_health', retention_days: 2555 }, // 7 years
        { classification: 'regulated_financial', retention_days: 1825 }, // 5 years
        // Component-specific override
        { classification: 'internal', retention_days: 30, component: 'Telemetry_Service' },
      ],
      residencyRegion: 'us-east-1',
    });
  });

  describe('expired record detection', () => {
    it('should mark records that have exceeded retention duration', async () => {
      const record = createRecord({
        classification: 'internal',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // 91 days later — exceeds 90-day retention
      const now = new Date('2024-04-02T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.record_id).toBe('record-1');
    });

    it('should not mark records that have not yet expired', async () => {
      const record = createRecord({
        classification: 'internal',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // 89 days later — within 90-day retention
      const now = new Date('2024-03-30T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(0);
    });

    it('should mark records exactly at expiry boundary', async () => {
      const record = createRecord({
        classification: 'internal',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // Exactly 90 days later
      const now = new Date('2024-03-31T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
    });
  });

  describe('deletion method selection', () => {
    it('should use cryptographic_shred for regulated_pii', async () => {
      const record = createRecord({
        classification: 'regulated_pii',
        created_at: '2022-01-01T00:00:00.000Z', // Well past 730-day retention
      });

      const now = new Date('2024-06-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.deletion_method).toBe('cryptographic_shred');
    });

    it('should use cryptographic_shred for regulated_health', async () => {
      const record = createRecord({
        classification: 'regulated_health',
        created_at: '2015-01-01T00:00:00.000Z', // Well past 7-year retention
      });

      const now = new Date('2024-06-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.deletion_method).toBe('cryptographic_shred');
    });

    it('should use cryptographic_shred for regulated_financial', async () => {
      const record = createRecord({
        classification: 'regulated_financial',
        created_at: '2018-01-01T00:00:00.000Z', // Well past 5-year retention
      });

      const now = new Date('2024-06-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.deletion_method).toBe('cryptographic_shred');
    });

    it('should use cryptographic_shred for restricted', async () => {
      const record = createRecord({
        classification: 'restricted',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // 31 days later — exceeds 30-day retention
      const now = new Date('2024-02-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.deletion_method).toBe('cryptographic_shred');
    });

    it('should use irreversible_delete for public data', async () => {
      const record = createRecord({
        classification: 'public',
        created_at: '2022-01-01T00:00:00.000Z', // Past 365-day retention
      });

      const now = new Date('2024-06-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.deletion_method).toBe('irreversible_delete');
    });

    it('should use irreversible_delete for internal data', async () => {
      const record = createRecord({
        classification: 'internal',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const now = new Date('2024-04-02T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      expect(result.expired_records[0]!.deletion_method).toBe('irreversible_delete');
    });
  });

  describe('deletion deadline', () => {
    it('should set deletion deadline within 24 hours of enforcement', async () => {
      const record = createRecord({
        classification: 'internal',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const now = new Date('2024-04-02T12:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
      const deadline = new Date(result.expired_records[0]!.deletion_deadline);
      const expectedDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      expect(deadline.getTime()).toBe(expectedDeadline.getTime());
    });
  });

  describe('component-specific rules', () => {
    it('should use component-specific rule when available', async () => {
      const record = createRecord({
        classification: 'internal',
        component: 'Telemetry_Service',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // 31 days later — exceeds 30-day component-specific retention
      const now = new Date('2024-02-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(1);
    });

    it('should fall back to classification rule when no component rule exists', async () => {
      const record = createRecord({
        classification: 'internal',
        component: 'Memory_Service', // No component-specific rule
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // 31 days later — within 90-day classification-level retention
      const now = new Date('2024-02-01T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(0);
    });

    it('should not expire record within component-specific retention', async () => {
      const record = createRecord({
        classification: 'internal',
        component: 'Telemetry_Service',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // 29 days later — within 30-day component-specific retention
      const now = new Date('2024-01-30T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it('should skip records from other tenants', async () => {
      const record = createRecord({
        tenant_id: 'tenant-2',
        classification: 'internal',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const now = new Date('2024-04-02T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', [record], now);

      expect(result.expired_records).toHaveLength(0);
    });
  });

  describe('multiple records', () => {
    it('should evaluate multiple records and return only expired ones', async () => {
      const records: RetentionRecord[] = [
        createRecord({
          record_id: 'expired-1',
          classification: 'internal',
          created_at: '2024-01-01T00:00:00.000Z',
        }),
        createRecord({
          record_id: 'not-expired',
          classification: 'public',
          created_at: '2024-03-01T00:00:00.000Z', // Within 365-day retention
        }),
        createRecord({
          record_id: 'expired-2',
          classification: 'restricted',
          created_at: '2024-03-01T00:00:00.000Z', // Past 30-day retention
        }),
      ];

      const now = new Date('2024-04-02T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-1', records, now);

      expect(result.expired_records).toHaveLength(2);
      const expiredIds = result.expired_records.map((r) => r.record_id);
      expect(expiredIds).toContain('expired-1');
      expect(expiredIds).toContain('expired-2');
      expect(expiredIds).not.toContain('not-expired');
    });
  });

  describe('no retention rules', () => {
    it('should not expire any records when no rules are configured', async () => {
      store.configure('tenant-no-rules', {
        classifications: ['internal'],
        retentionRules: [],
        residencyRegion: 'us-east-1',
      });

      const record = createRecord({
        tenant_id: 'tenant-no-rules',
        classification: 'internal',
        created_at: '2020-01-01T00:00:00.000Z', // Very old
      });

      const now = new Date('2024-04-02T00:00:00.000Z');
      const result = await enforcer.enforce('tenant-no-rules', [record], now);

      expect(result.expired_records).toHaveLength(0);
    });
  });
});
