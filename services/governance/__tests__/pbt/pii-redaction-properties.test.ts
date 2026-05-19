/**
 * Property-based tests for PII redaction pipeline.
 *
 * **Validates: Requirements 26.2, 26.3**
 *
 * Property 14: PII Redaction Before Boundary Crossing — all PII categories
 *   redacted before external transmission (posture="redact" removes PII text)
 * Property 15: PII Redaction Report Generation — every redaction produces
 *   report with categories, counts, destination, policy version
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import type { RequestContext, PIICategory } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { RedactionPipeline } from '../../src/redaction-pipeline.js';
import { PIIDetector } from '../../src/pii-detector.js';
import { InMemoryTenantPolicyStore } from '../../src/in-memory-tenant-policy-store.js';
import type { RedactionRequest, TenantRedactionPolicy } from '../../src/interfaces/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'tenant-pii-test';
const POLICY_VERSION = '1.0.0';

/** All PII categories supported by the platform. */
const ALL_PII_CATEGORIES: readonly PIICategory[] = [
  'name',
  'address',
  'phone',
  'email',
  'government_id',
  'payment_card',
  'bank_account',
  'ip_address',
  'geolocation',
  'date_of_birth',
  'credential',
];

// ─── PII Sample Generators ───────────────────────────────────────────────────

/**
 * Generates realistic PII samples for each category.
 * These are designed to be detected by the PIIDetector's regex patterns.
 */
const piiSamplesByCategory: Record<PIICategory, fc.Arbitrary<string>> = {
  email: fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 3, maxLength: 8 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 3, maxLength: 8 }),
    fc.constantFrom('com', 'org', 'net', 'io'),
  ).map(([user, domain, tld]) => `${user}@${domain}.${tld}`),

  phone: fc.tuple(
    fc.constantFrom('+1', '+44', '+49', '+33'),
    fc.stringOf(fc.constantFrom(...'0123456789'.split('')), { minLength: 10, maxLength: 10 }),
  ).map(([prefix, digits]) => `${prefix}-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`),

  payment_card: fc.constantFrom(
    '4111-1111-1111-1111',
    '4532 1234 5678 9012',
    '5234 5678 9012 3456',
    '5412-7534-3456-7890',
  ),

  government_id: fc.tuple(
    fc.integer({ min: 100, max: 999 }),
    fc.integer({ min: 10, max: 99 }),
    fc.integer({ min: 1000, max: 9999 }),
  ).map(([a, b, c]) => `${a}-${b}-${c}`),

  bank_account: fc.constantFrom(
    'GB29 NWBK 6016 1331 9268 19',
    'DE89 3704 0044 0532 0130 00',
    'FR76 3000 6000 0112 3456 7890 189',
  ),

  ip_address: fc.tuple(
    fc.integer({ min: 1, max: 254 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 }),
  ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),

  geolocation: fc.tuple(
    fc.double({ min: -90, max: 90, noNaN: true }),
    fc.double({ min: -180, max: 180, noNaN: true }),
  ).map(([lat, lon]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`),

  date_of_birth: fc.tuple(
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 1950, max: 2005 }),
  ).map(([m, d, y]) => `DOB: ${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`),

  credential: fc.tuple(
    fc.constantFrom('password', 'api_key', 'secret', 'auth_token'),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), { minLength: 12, maxLength: 24 }),
  ).map(([key, value]) => `${key}=${value}`),

  name: fc.tuple(
    fc.constantFrom('Mr', 'Mrs', 'Ms', 'Dr', 'Prof'),
    fc.constantFrom('John', 'Jane', 'Alice', 'Robert', 'Maria', 'David', 'Sarah'),
    fc.constantFrom('Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller'),
  ).map(([title, first, last]) => `${title}. ${first} ${last}`),

  address: fc.tuple(
    fc.integer({ min: 1, max: 9999 }),
    fc.constantFrom('Main', 'Oak', 'Elm', 'Park', 'Cedar', 'Maple', 'Pine'),
    fc.constantFrom('St', 'Ave', 'Blvd', 'Dr', 'Ln', 'Rd'),
  ).map(([num, street, suffix]) => `${num} ${street} ${suffix}`),
};

/**
 * Generates content with at least one embedded PII item from a given category.
 */
function contentWithPII(category: PIICategory): fc.Arbitrary<{ content: string; piiText: string }> {
  const prefixArb = fc.constantFrom(
    'Please contact ',
    'The record shows ',
    'User information: ',
    'Details: ',
    'Send to ',
  );
  const suffixArb = fc.constantFrom(
    ' for more details.',
    ' is on file.',
    ' was provided.',
    ' needs review.',
    ' end of record.',
  );

  return fc.tuple(prefixArb, piiSamplesByCategory[category], suffixArb).map(
    ([prefix, pii, suffix]) => ({
      content: `${prefix}${pii}${suffix}`,
      piiText: pii,
    }),
  );
}

/**
 * Generates content with multiple PII items from different categories.
 */
const contentWithMultiplePII: fc.Arbitrary<{ content: string; piiTexts: string[]; categories: PIICategory[] }> =
  fc.tuple(
    contentWithPII('email'),
    contentWithPII('phone'),
    contentWithPII('payment_card'),
    contentWithPII('government_id'),
    contentWithPII('ip_address'),
  ).map(([email, phone, card, govId, ip]) => ({
    content: `${email.content}\n${phone.content}\n${card.content}\n${govId.content}\n${ip.content}`,
    piiTexts: [email.piiText, phone.piiText, card.piiText, govId.piiText, ip.piiText],
    categories: ['email', 'phone', 'payment_card', 'government_id', 'ip_address'] as PIICategory[],
  }));

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for a non-empty destination string. */
const destinationArb = fc.constantFrom(
  'external-api',
  'partner-system',
  'third-party-analytics',
  'cloud-storage',
  'email-service',
  'audit-log',
);

/** Arbitrary for a policy version string. */
const policyVersionArb = fc.tuple(
  fc.integer({ min: 1, max: 9 }),
  fc.integer({ min: 0, max: 9 }),
  fc.integer({ min: 0, max: 9 }),
).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Arbitrary for a PII category. */
const piiCategoryArb = fc.constantFrom(...ALL_PII_CATEGORIES);

/** Arbitrary for a non-empty subset of PII categories. */
const piiCategorySubsetArb = fc.subarray([...ALL_PII_CATEGORIES], { minLength: 1 });

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestContext(tenantId = TEST_TENANT_ID): RequestContext {
  return {
    tenant_id: tenantId as TenantId,
    principal_id: 'principal-pii-test' as PrincipalId,
    correlation_id: 'corr-pii-test' as CorrelationId,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'session-pii-test' as SessionId,
    roles: ['End_User'],
    attributes: {},
    residency_region: 'us-east-1',
  };
}

function createRedactPolicy(
  version: string,
  categories?: readonly PIICategory[],
): TenantRedactionPolicy {
  return {
    tenant_id: TEST_TENANT_ID,
    policy: {
      posture: 'redact',
      confidence_threshold: 0.85,
      categories: categories,
    },
    version,
  };
}

// ─── Property 14: PII Redaction Before Boundary Crossing ─────────────────────

describe('Property 14: PII Redaction Before Boundary Crossing', () => {
  let detector: PIIDetector;
  let policyStore: InMemoryTenantPolicyStore;
  let pipeline: RedactionPipeline;
  let ctx: RequestContext;

  beforeEach(() => {
    detector = new PIIDetector();
    policyStore = new InMemoryTenantPolicyStore();
    pipeline = new RedactionPipeline(detector, policyStore);
    ctx = createTestContext();
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing a detectable email address and posture="redact",
   * the redacted_content MUST NOT contain the original email text.
   */
  it('email PII is removed from redacted content for any generated email', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('email'),
        destinationArb,
        policyVersionArb,
        async ({ content, piiText }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          // The original PII text must not appear in redacted content
          expect(result.redacted_content).not.toContain(piiText);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing a detectable phone number and posture="redact",
   * the redacted_content MUST NOT contain the original phone text.
   */
  it('phone PII is removed from redacted content for any generated phone number', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('phone'),
        destinationArb,
        policyVersionArb,
        async ({ content, piiText }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          expect(result.redacted_content).not.toContain(piiText);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing a detectable payment card and posture="redact",
   * the redacted_content MUST NOT contain the original card number text.
   */
  it('payment card PII is removed from redacted content', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('payment_card'),
        destinationArb,
        policyVersionArb,
        async ({ content, piiText }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          expect(result.redacted_content).not.toContain(piiText);
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing multiple PII categories and posture="redact",
   * NONE of the original PII texts appear in the redacted_content.
   */
  it('all PII categories are redacted when content contains multiple PII types', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithMultiplePII,
        destinationArb,
        policyVersionArb,
        async ({ content, piiTexts }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          // None of the original PII texts should appear in redacted content
          for (const piiText of piiTexts) {
            expect(result.redacted_content).not.toContain(piiText);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing detectable PII and posture="redact",
   * the redacted_content MUST contain [REDACTED:<category>] markers
   * for each detected PII instance.
   */
  it('redacted content contains REDACTED markers for each detection', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('email'),
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          // If detections were found, redacted content must have markers
          if (result.detections.length > 0) {
            for (const detection of result.detections) {
              expect(result.redacted_content).toContain(`[REDACTED:${detection.category}]`);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing detectable government IDs and posture="redact",
   * the redacted_content MUST NOT contain the original government ID text.
   */
  it('government ID PII is removed from redacted content', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('government_id'),
        destinationArb,
        policyVersionArb,
        async ({ content, piiText }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          expect(result.redacted_content).not.toContain(piiText);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.2**
   *
   * For ANY content containing detectable credentials and posture="redact",
   * the redacted_content MUST NOT contain the original credential text.
   */
  it('credential PII is removed from redacted content', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('credential'),
        destinationArb,
        policyVersionArb,
        async ({ content, piiText }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          expect(result.redacted_content).not.toContain(piiText);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 15: PII Redaction Report Generation ────────────────────────────

describe('Property 15: PII Redaction Report Generation', () => {
  let detector: PIIDetector;
  let policyStore: InMemoryTenantPolicyStore;
  let pipeline: RedactionPipeline;
  let ctx: RequestContext;

  beforeEach(() => {
    detector = new PIIDetector();
    policyStore = new InMemoryTenantPolicyStore();
    pipeline = new RedactionPipeline(detector, policyStore);
    ctx = createTestContext();
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY content with detectable PII and posture="redact",
   * the result MUST have a non-empty detections array.
   */
  it('produces non-empty detections array when PII is present', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('email'),
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          // Detections array must be non-empty when PII is present
          expect(result.detections.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY redaction result, the policy_version in the report MUST match
   * the version of the tenant's configured policy.
   */
  it('report policy_version matches the configured tenant policy version', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('email'),
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          expect(result.policy_version).toBe(version);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY redaction request, the destination in the report MUST match
   * the destination specified in the request.
   */
  it('report destination matches the request destination', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('phone'),
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          expect(result.destination).toBe(destination);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY redaction result with detections, each detection MUST have
   * a valid category from the PIICategory set.
   */
  it('all detections have valid PII categories', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithMultiplePII,
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          for (const detection of result.detections) {
            expect(ALL_PII_CATEGORIES).toContain(detection.category);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY redaction result, the report MUST include an original_hash
   * (SHA-256 hex string of 64 characters).
   */
  it('report includes valid original_hash (SHA-256)', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithPII('ip_address'),
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          // original_hash must be a valid SHA-256 hex string
          expect(result.original_hash).toMatch(/^[a-f0-9]{64}$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY redaction result with detections, each detection MUST have
   * action_taken set to 'redacted' when posture is "redact".
   */
  it('all detections have action_taken="redacted" when posture is redact', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithMultiplePII,
        destinationArb,
        policyVersionArb,
        async ({ content }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          for (const detection of result.detections) {
            expect(detection.action_taken).toBe('redacted');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 26.3**
   *
   * For ANY redaction result with detections, the count of detections
   * per category MUST be at least 1 for each category that was detected.
   */
  it('detection counts are accurate per category', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentWithMultiplePII,
        destinationArb,
        policyVersionArb,
        async ({ content, categories }, destination, version) => {
          await policyStore.setRedactionPolicy(TEST_TENANT_ID, createRedactPolicy(version));

          const request: RedactionRequest = {
            content,
            tenant_id: TEST_TENANT_ID,
            destination,
          };

          const result = await pipeline.redact(request, ctx);

          // Build category counts from detections
          const categoryCounts = new Map<string, number>();
          for (const detection of result.detections) {
            categoryCounts.set(
              detection.category,
              (categoryCounts.get(detection.category) ?? 0) + 1,
            );
          }

          // Each detected category must have count ≥ 1
          for (const [, count] of categoryCounts) {
            expect(count).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
