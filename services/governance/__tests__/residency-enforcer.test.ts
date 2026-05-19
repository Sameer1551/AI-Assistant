/**
 * Unit tests for ResidencyEnforcer.
 *
 * Verifies:
 * - Operations in the configured region are allowed
 * - Operations outside the configured region are denied
 * - Case-insensitive region comparison
 * - Migration plan generation with all required components
 * - Migration plan starts unverified
 *
 * @see Requirement 25.4 - Data_Residency_Region enforcement
 * @see Requirement 25.5 - Region migration planning
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { ResidencyEnforcer } from '../src/residency-enforcer.js';
import { InMemoryTenantTaxonomyStore } from '../src/in-memory-tenant-taxonomy-store.js';
import type { ResidencyValidationRequest } from '../src/interfaces/classification-service.js';

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

function createValidationRequest(
  overrides: Partial<ResidencyValidationRequest> = {},
): ResidencyValidationRequest {
  return {
    tenant_id: 'tenant-1',
    target_region: 'us-east-1',
    operation_type: 'persistence',
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('ResidencyEnforcer', () => {
  let store: InMemoryTenantTaxonomyStore;
  let enforcer: ResidencyEnforcer;
  let ctx: RequestContext;

  beforeEach(() => {
    store = new InMemoryTenantTaxonomyStore();
    enforcer = new ResidencyEnforcer(store);
    ctx = createTestContext();

    store.configure('tenant-1', {
      classifications: ['public', 'internal', 'confidential'],
      retentionRules: [],
      residencyRegion: 'us-east-1',
    });

    store.configure('tenant-eu', {
      classifications: ['public', 'internal', 'confidential'],
      retentionRules: [],
      residencyRegion: 'eu-west-1',
    });
  });

  describe('validate', () => {
    it('should allow operations in the configured region', async () => {
      const request = createValidationRequest({
        target_region: 'us-east-1',
      });

      const result = await enforcer.validate(request, ctx);

      expect(result.allowed).toBe(true);
      expect(result.configured_region).toBe('us-east-1');
      expect(result.target_region).toBe('us-east-1');
      expect(result.denial_reason).toBeUndefined();
    });

    it('should deny operations outside the configured region', async () => {
      const request = createValidationRequest({
        target_region: 'eu-west-1',
      });

      const result = await enforcer.validate(request, ctx);

      expect(result.allowed).toBe(false);
      expect(result.configured_region).toBe('us-east-1');
      expect(result.target_region).toBe('eu-west-1');
      expect(result.denial_reason).toContain('violates tenant residency constraint');
    });

    it('should perform case-insensitive region comparison', async () => {
      const request = createValidationRequest({
        target_region: 'US-EAST-1',
      });

      const result = await enforcer.validate(request, ctx);

      expect(result.allowed).toBe(true);
    });

    it('should trim whitespace in region comparison', async () => {
      const request = createValidationRequest({
        target_region: '  us-east-1  ',
      });

      const result = await enforcer.validate(request, ctx);

      expect(result.allowed).toBe(true);
    });

    it('should validate persistence operations', async () => {
      const request = createValidationRequest({
        target_region: 'ap-southeast-1',
        operation_type: 'persistence',
      });

      const result = await enforcer.validate(request, ctx);

      expect(result.allowed).toBe(false);
      expect(result.denial_reason).toBeDefined();
    });

    it('should validate processing operations', async () => {
      const request = createValidationRequest({
        target_region: 'ap-southeast-1',
        operation_type: 'processing',
      });

      const result = await enforcer.validate(request, ctx);

      expect(result.allowed).toBe(false);
    });

    it('should enforce different regions for different tenants', async () => {
      const ctxEu = createTestContext('tenant-eu');
      const request = createValidationRequest({
        tenant_id: 'tenant-eu',
        target_region: 'eu-west-1',
      });

      const result = await enforcer.validate(request, ctxEu);

      expect(result.allowed).toBe(true);
      expect(result.configured_region).toBe('eu-west-1');
    });

    it('should deny EU tenant operations in US region', async () => {
      const ctxEu = createTestContext('tenant-eu');
      const request = createValidationRequest({
        tenant_id: 'tenant-eu',
        target_region: 'us-east-1',
      });

      const result = await enforcer.validate(request, ctxEu);

      expect(result.allowed).toBe(false);
      expect(result.denial_reason).toContain('eu-west-1');
    });
  });

  describe('createMigrationPlan', () => {
    it('should produce a migration plan with steps for all components', async () => {
      const plan = await enforcer.createMigrationPlan(
        'tenant-1',
        'us-east-1',
        'eu-west-1',
      );

      expect(plan.tenant_id).toBe('tenant-1');
      expect(plan.source_region).toBe('us-east-1');
      expect(plan.target_region).toBe('eu-west-1');
      expect(plan.verified).toBe(false);
      expect(plan.created_at).toBeDefined();
      expect(plan.steps.length).toBeGreaterThan(0);
    });

    it('should include steps for key platform components', async () => {
      const plan = await enforcer.createMigrationPlan(
        'tenant-1',
        'us-east-1',
        'eu-west-1',
      );

      const components = plan.steps.map((s) => s.component);
      expect(components).toContain('Memory_Service');
      expect(components).toContain('Audit_Service');
      expect(components).toContain('Workflow_Service');
    });

    it('should include a verification step', async () => {
      const plan = await enforcer.createMigrationPlan(
        'tenant-1',
        'us-east-1',
        'eu-west-1',
      );

      const verifyStep = plan.steps.find((s) => s.component === 'Governance_Service');
      expect(verifyStep).toBeDefined();
      expect(verifyStep!.description).toContain('Verify');
    });

    it('should start all steps in pending status', async () => {
      const plan = await enforcer.createMigrationPlan(
        'tenant-1',
        'us-east-1',
        'eu-west-1',
      );

      for (const step of plan.steps) {
        expect(step.status).toBe('pending');
      }
    });

    it('should start with verified = false', async () => {
      const plan = await enforcer.createMigrationPlan(
        'tenant-1',
        'us-east-1',
        'eu-west-1',
      );

      expect(plan.verified).toBe(false);
    });

    it('should assign unique step IDs', async () => {
      const plan = await enforcer.createMigrationPlan(
        'tenant-1',
        'us-east-1',
        'eu-west-1',
      );

      const stepIds = plan.steps.map((s) => s.step_id);
      const uniqueIds = new Set(stepIds);
      expect(uniqueIds.size).toBe(stepIds.length);
    });
  });
});
