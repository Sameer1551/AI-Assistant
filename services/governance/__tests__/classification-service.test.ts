/**
 * Unit tests for ClassificationService.
 *
 * Verifies:
 * - Explicit classification with valid taxonomy
 * - Explicit classification rejection for invalid taxonomy entries
 * - Inferred classification from content patterns
 * - Default classification when no patterns match
 * - Tenant-specific taxonomy enforcement
 *
 * @see Requirement 25.1 - Tenant-configurable data classification taxonomy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { ClassificationService } from '../src/classification-service.js';
import { InMemoryTenantTaxonomyStore } from '../src/in-memory-tenant-taxonomy-store.js';
import type { ClassifyRequest } from '../src/interfaces/classification-service.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestContext(tenantId = 'tenant-1'): RequestContext {
  return {
    tenant_id: tenantId as TenantId,
    principal_id: 'principal-1' as PrincipalId,
    correlation_id: 'corr-123' as CorrelationId,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'session-1' as SessionId,
    roles: ['Tenant_Administrator'],
    attributes: {},
    residency_region: 'us-east-1',
  };
}

function createClassifyRequest(overrides: Partial<ClassifyRequest> = {}): ClassifyRequest {
  return {
    record_id: 'record-1',
    tenant_id: 'tenant-1',
    content: 'Some generic content',
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('ClassificationService', () => {
  let store: InMemoryTenantTaxonomyStore;
  let service: ClassificationService;
  let ctx: RequestContext;

  beforeEach(() => {
    store = new InMemoryTenantTaxonomyStore();
    service = new ClassificationService(store);
    ctx = createTestContext();

    // Configure tenant with full taxonomy
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
      retentionRules: [],
      residencyRegion: 'us-east-1',
    });
  });

  describe('explicit classification', () => {
    it('should accept a valid explicit classification', async () => {
      const request = createClassifyRequest({
        explicit_classification: 'confidential',
      });

      const result = await service.classify(request, ctx);

      expect(result.record_id).toBe('record-1');
      expect(result.classification).toBe('confidential');
      expect(result.confidence).toBe(1.0);
      expect(result.method).toBe('explicit');
      expect(result.classified_at).toBeDefined();
    });

    it('should reject an explicit classification not in tenant taxonomy', async () => {
      // Configure tenant with limited taxonomy
      store.configure('tenant-1', {
        classifications: ['public', 'internal', 'confidential'],
        retentionRules: [],
        residencyRegion: 'us-east-1',
      });

      const request = createClassifyRequest({
        explicit_classification: 'regulated_health',
      });

      await expect(service.classify(request, ctx)).rejects.toThrow(
        /not in tenant taxonomy/,
      );
    });

    it('should accept all default taxonomy classifications', async () => {
      const classifications = [
        'public',
        'internal',
        'confidential',
        'restricted',
        'regulated_pii',
        'regulated_health',
        'regulated_financial',
      ] as const;

      for (const classification of classifications) {
        const request = createClassifyRequest({
          record_id: `record-${classification}`,
          explicit_classification: classification,
        });

        const result = await service.classify(request, ctx);
        expect(result.classification).toBe(classification);
        expect(result.method).toBe('explicit');
      }
    });
  });

  describe('inferred classification', () => {
    it('should infer regulated_pii from SSN-related content', async () => {
      const request = createClassifyRequest({
        content: 'This document contains the SSN of the employee',
      });

      const result = await service.classify(request, ctx);

      expect(result.classification).toBe('regulated_pii');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.method).toBe('inferred');
    });

    it('should infer regulated_health from medical content', async () => {
      const request = createClassifyRequest({
        content: 'Patient diagnosis report for annual checkup',
      });

      const result = await service.classify(request, ctx);

      expect(result.classification).toBe('regulated_health');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.method).toBe('inferred');
    });

    it('should infer regulated_financial from payment content', async () => {
      const request = createClassifyRequest({
        content: 'Credit card payment processing details',
      });

      const result = await service.classify(request, ctx);

      expect(result.classification).toBe('regulated_financial');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.method).toBe('inferred');
    });

    it('should infer restricted from credential content', async () => {
      const request = createClassifyRequest({
        content: 'The API key for the production service',
      });

      const result = await service.classify(request, ctx);

      expect(result.classification).toBe('restricted');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.method).toBe('inferred');
    });

    it('should infer confidential from proprietary content', async () => {
      const request = createClassifyRequest({
        content: 'This is a proprietary document covered by NDA',
      });

      const result = await service.classify(request, ctx);

      expect(result.classification).toBe('confidential');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.method).toBe('inferred');
    });

    it('should default to internal when no patterns match', async () => {
      const request = createClassifyRequest({
        content: 'Just a regular meeting note about project status',
      });

      const result = await service.classify(request, ctx);

      expect(result.classification).toBe('internal');
      expect(result.confidence).toBe(0.5);
      expect(result.method).toBe('inferred');
    });

    it('should only infer classifications in the tenant taxonomy', async () => {
      // Configure tenant without regulated classifications
      store.configure('tenant-1', {
        classifications: ['public', 'internal', 'confidential'],
        retentionRules: [],
        residencyRegion: 'us-east-1',
      });

      const request = createClassifyRequest({
        content: 'Patient diagnosis report with SSN',
      });

      const result = await service.classify(request, ctx);

      // Should not classify as regulated_pii or regulated_health since not in taxonomy
      expect(['public', 'internal', 'confidential']).toContain(result.classification);
    });
  });

  describe('tenant isolation', () => {
    it('should use tenant-specific taxonomy', async () => {
      store.configure('tenant-2', {
        classifications: ['public', 'internal'],
        retentionRules: [],
        residencyRegion: 'eu-west-1',
      });

      const request = createClassifyRequest({
        tenant_id: 'tenant-2',
        explicit_classification: 'confidential',
      });

      const ctx2 = createTestContext('tenant-2');

      await expect(service.classify(request, ctx2)).rejects.toThrow(
        /not in tenant taxonomy/,
      );
    });

    it('should use default taxonomy for unconfigured tenants', async () => {
      const request = createClassifyRequest({
        tenant_id: 'tenant-unknown',
        explicit_classification: 'restricted',
      });

      const ctxUnknown = createTestContext('tenant-unknown');
      const result = await service.classify(request, ctxUnknown);

      expect(result.classification).toBe('restricted');
    });
  });
});
