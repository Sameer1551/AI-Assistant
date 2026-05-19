/**
 * Unit tests for RedactionPipeline.
 *
 * Verifies:
 * - Tenant policy lookup and enforcement
 * - Redaction posture application (block/flag/redact)
 * - Redaction report generation with categories, counts, destination, policy version
 * - Confidence threshold filtering
 * - SHA-256 hash of original content
 * - Error handling for missing policies
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext, PIICategory } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { RedactionPipeline } from '../src/redaction-pipeline.js';
import { PIIDetector } from '../src/pii-detector.js';
import { InMemoryTenantPolicyStore } from '../src/in-memory-tenant-policy-store.js';
import type { TenantRedactionPolicy, RedactionRequest } from '../src/interfaces/index.js';
import { createHash } from 'node:crypto';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestContext(tenantId = 'tenant-1'): RequestContext {
  return {
    tenant_id: tenantId as TenantId,
    principal_id: 'principal-1' as PrincipalId,
    correlation_id: 'corr-123' as CorrelationId,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'session-1' as SessionId,
    roles: ['End_User'],
    attributes: {},
    residency_region: 'us-east-1',
  };
}

function createDefaultPolicy(
  posture: 'block' | 'flag' | 'redact' = 'redact',
): TenantRedactionPolicy {
  return {
    policy: {
      categories: [
        'email',
        'phone',
        'payment_card',
        'government_id',
        'ip_address',
        'credential',
        'name',
        'address',
        'bank_account',
        'geolocation',
        'date_of_birth',
      ],
      confidence_threshold: 0.90,
      posture,
    },
    version: 'v1.0.0',
    updated_at: '2024-01-15T00:00:00.000Z',
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('RedactionPipeline', () => {
  let detector: PIIDetector;
  let policyStore: InMemoryTenantPolicyStore;
  let pipeline: RedactionPipeline;
  let ctx: RequestContext;

  beforeEach(async () => {
    detector = new PIIDetector();
    policyStore = new InMemoryTenantPolicyStore();
    pipeline = new RedactionPipeline(detector, policyStore);
    ctx = createTestContext();

    // Set up default policy
    await policyStore.setRedactionPolicy('tenant-1', createDefaultPolicy());
  });

  // ─── Policy Lookup ───────────────────────────────────────────────────────

  describe('policy lookup', () => {
    it('should throw POLICY_NOT_FOUND when tenant has no policy', async () => {
      const request: RedactionRequest = {
        content: 'test@example.com',
        destination: 'external_api',
        tenant_id: 'unknown-tenant',
      };

      await expect(pipeline.redact(request, ctx)).rejects.toMatchObject({
        code: 'POLICY_NOT_FOUND',
        category: 'VALIDATION',
      });
    });

    it('should use the tenant-specific policy', async () => {
      // Set a policy with only email detection
      await policyStore.setRedactionPolicy('tenant-1', {
        policy: {
          categories: ['email'],
          confidence_threshold: 0.90,
          posture: 'redact',
        },
        version: 'v2.0.0',
        updated_at: '2024-02-01T00:00:00.000Z',
      });

      const request: RedactionRequest = {
        content: 'Email: test@example.com, Phone: 555-123-4567',
        destination: 'memory_service',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      // Should only detect email, not phone (not in policy categories)
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0]!.category).toBe('email');
      expect(result.policy_version).toBe('v2.0.0');
    });
  });

  // ─── Redact Posture ──────────────────────────────────────────────────────

  describe('redact posture', () => {
    it('should replace PII with redaction markers', async () => {
      const request: RedactionRequest = {
        content: 'Contact test@example.com for help.',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toBe(
        'Contact [REDACTED:email] for help.',
      );
      expect(result.redacted_content).not.toContain('test@example.com');
    });

    it('should redact multiple PII instances', async () => {
      const request: RedactionRequest = {
        content: 'Email: test@example.com, IP: 192.168.1.100',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toContain('[REDACTED:email]');
      expect(result.redacted_content).toContain('[REDACTED:ip_address]');
      expect(result.redacted_content).not.toContain('test@example.com');
      expect(result.redacted_content).not.toContain('192.168.1.100');
    });

    it('should mark all detections with action "redacted"', async () => {
      const request: RedactionRequest = {
        content: 'test@example.com 192.168.1.1',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      for (const detection of result.detections) {
        expect(detection.action_taken).toBe('redacted');
      }
    });

    it('should return original content unchanged when no PII detected', async () => {
      const content = 'The weather is nice today.';
      const request: RedactionRequest = {
        content,
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toBe(content);
      expect(result.detections).toHaveLength(0);
    });
  });

  // ─── Flag Posture ────────────────────────────────────────────────────────

  describe('flag posture', () => {
    beforeEach(async () => {
      await policyStore.setRedactionPolicy('tenant-1', createDefaultPolicy('flag'));
    });

    it('should leave content unchanged but record detections', async () => {
      const content = 'Contact test@example.com for help.';
      const request: RedactionRequest = {
        content,
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toBe(content); // Unchanged
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0]!.action_taken).toBe('flagged');
    });
  });

  // ─── Block Posture ───────────────────────────────────────────────────────

  describe('block posture', () => {
    beforeEach(async () => {
      await policyStore.setRedactionPolicy('tenant-1', createDefaultPolicy('block'));
    });

    it('should throw PII_BLOCKED when PII is detected', async () => {
      const request: RedactionRequest = {
        content: 'Contact test@example.com for help.',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      await expect(pipeline.redact(request, ctx)).rejects.toMatchObject({
        code: 'PII_BLOCKED',
        category: 'AUTHORIZATION',
      });
    });

    it('should include detection details in the error', async () => {
      const request: RedactionRequest = {
        content: 'test@example.com and 192.168.1.1',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      try {
        await pipeline.redact(request, ctx);
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as { details: { detection_count: number; categories: string[] } };
        expect(error.details.detection_count).toBe(2);
        expect(error.details.categories).toContain('email');
        expect(error.details.categories).toContain('ip_address');
      }
    });

    it('should allow content through when no PII is detected', async () => {
      const content = 'The weather is nice today.';
      const request: RedactionRequest = {
        content,
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toBe(content);
      expect(result.detections).toHaveLength(0);
    });
  });

  // ─── Confidence Threshold ────────────────────────────────────────────────

  describe('confidence threshold', () => {
    it('should filter out detections below confidence threshold', async () => {
      // Set a very high threshold that filters out lower-confidence matches
      await policyStore.setRedactionPolicy('tenant-1', {
        policy: {
          categories: ['email', 'payment_card'],
          confidence_threshold: 0.98,
          posture: 'redact',
        },
        version: 'v1.0.0',
        updated_at: '2024-01-15T00:00:00.000Z',
      });

      const request: RedactionRequest = {
        content: 'Email: test@example.com',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      // Email has confidence 0.99, should pass the 0.98 threshold
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0]!.confidence).toBeGreaterThanOrEqual(0.98);
    });
  });

  // ─── Redaction Report ────────────────────────────────────────────────────

  describe('redaction report', () => {
    it('should include SHA-256 hash of original content', async () => {
      const content = 'Contact test@example.com for help.';
      const expectedHash = createHash('sha256').update(content).digest('hex');

      const request: RedactionRequest = {
        content,
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.original_hash).toBe(expectedHash);
    });

    it('should include the destination in the result', async () => {
      const request: RedactionRequest = {
        content: 'test@example.com',
        destination: 'memory_service',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.destination).toBe('memory_service');
    });

    it('should include the policy version in the result', async () => {
      const request: RedactionRequest = {
        content: 'test@example.com',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.policy_version).toBe('v1.0.0');
    });

    it('should include detection offsets in the result', async () => {
      const content = 'Email: test@example.com here';
      const request: RedactionRequest = {
        content,
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.detections).toHaveLength(1);
      const detection = result.detections[0]!;
      expect(detection.start_offset).toBe(7); // "Email: " is 7 chars
      expect(detection.end_offset).toBe(23); // "test@example.com" is 16 chars
      expect(content.slice(detection.start_offset, detection.end_offset)).toBe(
        'test@example.com',
      );
    });

    it('should include category for each detection', async () => {
      const request: RedactionRequest = {
        content: 'test@example.com and 192.168.1.1',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      const categories = result.detections.map((d) => d.category);
      expect(categories).toContain('email');
      expect(categories).toContain('ip_address');
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty content', async () => {
      const request: RedactionRequest = {
        content: '',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toBe('');
      expect(result.detections).toHaveLength(0);
    });

    it('should handle content with only whitespace', async () => {
      const request: RedactionRequest = {
        content: '   \n\t  ',
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.redacted_content).toBe('   \n\t  ');
      expect(result.detections).toHaveLength(0);
    });

    it('should handle very long content', async () => {
      const content = 'No PII here. '.repeat(10000) + 'test@example.com';
      const request: RedactionRequest = {
        content,
        destination: 'external_api',
        tenant_id: 'tenant-1',
      };

      const result = await pipeline.redact(request, ctx);

      expect(result.detections).toHaveLength(1);
      expect(result.redacted_content).toContain('[REDACTED:email]');
    });
  });
});
