/**
 * Property-based tests for retention policy application.
 *
 * **Validates: Requirements 5.6, 25.2**
 *
 * Property 23: Retention Policy Application — records exceeding retention
 *   duration are marked for deletion/shredding; records younger than their
 *   retention rule are never marked as expired; deletion deadline is always
 *   within 24h of enforcement time.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import { RetentionEnforcer } from '../../src/retention-enforcer.js';
import { InMemoryTenantTaxonomyStore } from '../../src/in-memory-tenant-taxonomy-store.js';
import type { RetentionRecord, RetentionRule } from '../../src/interfaces/classification-service.js';
import type { DataClassification } from '@may/types';

// ─── Constants ───────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-pbt-retention';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELETION_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** All valid data classifications. */
const ALL_CLASSIFICATIONS: DataClassification[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'regulated_pii',
  'regulated_health',
  'regulated_financial',
];

/** Sample component names for generating records. */
const COMPONENTS = [
  'Memory_Service',
  'Audit_Service',
  'Telemetry_Service',
  'LLM_Gateway',
  'Workflow_Service',
];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for a valid DataClassification. */
const classificationArb: fc.Arbitrary<DataClassification> = fc.constantFrom(...ALL_CLASSIFICATIONS);

/** Arbitrary for a component name. */
const componentArb: fc.Arbitrary<string> = fc.constantFrom(...COMPONENTS);

/** Arbitrary for retention days (1 to 3650 days — up to 10 years). */
const retentionDaysArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 3650 });

/**
 * Arbitrary for a base date (the "now" reference point).
 * Constrained to a reasonable range to avoid overflow issues.
 */
const baseDateArb: fc.Arbitrary<Date> = fc.date({
  min: new Date('2024-01-01T00:00:00Z'),
  max: new Date('2030-12-31T23:59:59Z'),
});

/**
 * Generates a scenario with a single global retention rule and a record that
 * is guaranteed to be EXPIRED (older than the retention duration).
 *
 * This avoids ambiguity from multiple rules for the same classification.
 */
const expiredScenarioArb = fc.tuple(
  classificationArb,
  componentArb,
  retentionDaysArb,
  baseDateArb,
  fc.integer({ min: 1, max: 365 }), // extra days past expiry
).map(([classification, component, retentionDays, now, extraDays]) => {
  const ageDays = retentionDays + extraDays;
  const createdAt = new Date(now.getTime() - ageDays * MS_PER_DAY);
  const expiresAt = new Date(createdAt.getTime() + retentionDays * MS_PER_DAY);

  const rule: RetentionRule = { classification, retention_days: retentionDays };
  const record: RetentionRecord = {
    record_id: `expired-${classification}-${retentionDays}-${extraDays}`,
    tenant_id: TENANT_ID,
    classification,
    component,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  return { rule, record, now, retentionDays };
});

/**
 * Generates a scenario with a single global retention rule and a record that
 * is guaranteed to be FRESH (younger than the retention duration).
 *
 * The record's age is strictly less than retention_days.
 */
const freshScenarioArb = fc.tuple(
  classificationArb,
  componentArb,
  fc.integer({ min: 2, max: 3650 }), // retention_days >= 2 so we can have age < retention
  baseDateArb,
).chain(([classification, component, retentionDays, now]) => {
  // Age must be strictly less than retentionDays (0 to retentionDays - 1)
  return fc.integer({ min: 0, max: retentionDays - 1 }).map((ageDays) => {
    const createdAt = new Date(now.getTime() - ageDays * MS_PER_DAY);
    const expiresAt = new Date(createdAt.getTime() + retentionDays * MS_PER_DAY);

    const rule: RetentionRule = { classification, retention_days: retentionDays };
    const record: RetentionRecord = {
      record_id: `fresh-${classification}-${retentionDays}-${ageDays}`,
      tenant_id: TENANT_ID,
      classification,
      component,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    return { rule, record, now, retentionDays };
  });
});

/**
 * Generates a scenario with multiple expired records across different
 * classifications, each with its own retention rule.
 */
const multiExpiredScenarioArb = fc.tuple(
  baseDateArb,
  fc.array(
    fc.tuple(
      classificationArb,
      componentArb,
      retentionDaysArb,
      fc.integer({ min: 1, max: 365 }),
    ),
    { minLength: 1, maxLength: 5 },
  ),
).map(([now, entries]) => {
  const rules: RetentionRule[] = [];
  const records: RetentionRecord[] = [];
  const seenClassifications = new Set<DataClassification>();

  for (const [classification, component, retentionDays, extraDays] of entries) {
    // Only use one rule per classification to avoid ambiguity
    if (seenClassifications.has(classification)) continue;
    seenClassifications.add(classification);

    const ageDays = retentionDays + extraDays;
    const createdAt = new Date(now.getTime() - ageDays * MS_PER_DAY);
    const expiresAt = new Date(createdAt.getTime() + retentionDays * MS_PER_DAY);

    rules.push({ classification, retention_days: retentionDays });
    records.push({
      record_id: `multi-${classification}-${retentionDays}`,
      tenant_id: TENANT_ID,
      classification,
      component,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  }

  return { rules, records, now };
});

// ─── Property 23: Retention Policy Application ───────────────────────────────

describe('Property 23: Retention Policy Application', () => {
  let store: InMemoryTenantTaxonomyStore;
  let enforcer: RetentionEnforcer;

  beforeEach(() => {
    store = new InMemoryTenantTaxonomyStore();
    enforcer = new RetentionEnforcer(store);
  });

  it('records older than their applicable retention rule are always marked as expired', async () => {
    await fc.assert(
      fc.asyncProperty(
        expiredScenarioArb,
        async ({ rule, record, now }) => {
          // Configure the store with a single unambiguous rule
          store.configure(TENANT_ID, {
            classifications: ALL_CLASSIFICATIONS,
            retentionRules: [rule],
            residencyRegion: 'us-east-1',
          });

          const result = await enforcer.enforce(TENANT_ID, [record], now);

          // The expired record MUST appear in the result
          expect(result.expired_records.length).toBe(1);
          expect(result.expired_records[0]!.record_id).toBe(record.record_id);
          expect(result.expired_records[0]!.classification).toBe(record.classification);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('records younger than their retention rule are never marked as expired', async () => {
    await fc.assert(
      fc.asyncProperty(
        freshScenarioArb,
        async ({ rule, record, now }) => {
          // Configure the store with a single unambiguous rule
          store.configure(TENANT_ID, {
            classifications: ALL_CLASSIFICATIONS,
            retentionRules: [rule],
            residencyRegion: 'us-east-1',
          });

          const result = await enforcer.enforce(TENANT_ID, [record], now);

          // The fresh record MUST NOT appear in the result
          expect(result.expired_records.length).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('deletion deadline is always within 24h of enforcement time', async () => {
    await fc.assert(
      fc.asyncProperty(
        multiExpiredScenarioArb,
        async ({ rules, records, now }) => {
          // Configure the store with the generated rules
          store.configure(TENANT_ID, {
            classifications: ALL_CLASSIFICATIONS,
            retentionRules: rules,
            residencyRegion: 'us-east-1',
          });

          const result = await enforcer.enforce(TENANT_ID, records, now);

          // For every expired record, the deletion deadline must be exactly
          // enforcement time + 24 hours
          for (const expired of result.expired_records) {
            const deadline = new Date(expired.deletion_deadline).getTime();
            const expectedDeadline = now.getTime() + DELETION_DEADLINE_MS;

            // Deadline must be exactly 24h from enforcement time
            expect(deadline).toBe(expectedDeadline);

            // Also verify it's within 24h (not exceeding)
            const diffMs = deadline - now.getTime();
            expect(diffMs).toBeLessThanOrEqual(DELETION_DEADLINE_MS);
            expect(diffMs).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
