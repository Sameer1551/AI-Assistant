/**
 * Unit tests for AuthorizationService — RBAC/ABAC authorization engine.
 *
 * Verifies:
 * - Default-deny behavior (Requirement 12.5)
 * - Built-in role permissions (Requirement 12.1)
 * - Custom role definitions (Requirement 12.2)
 * - Role + attribute evaluation (Requirement 12.3)
 * - Audit event emission (Requirement 12.4)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationService } from '../src/authorization-service.js';
import { InMemoryPolicyStore } from '../src/in-memory-policy-store.js';
import type {
  IAuthzAuditEmitter,
  IClock,
  IIdGenerator,
  AuthzRequest,
  AuthzAuditPayload,
  RoleDefinition,
} from '../src/interfaces/index.js';
import type { TenantId, PrincipalId, CorrelationId, ISOTimestamp } from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTenantId(id: string): TenantId {
  return id as TenantId;
}

function makePrincipalId(id: string): PrincipalId {
  return id as PrincipalId;
}

function makeCorrelationId(id: string): CorrelationId {
  return id as CorrelationId;
}

// ─── Mock Implementations ────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentSeconds = 1700000000; // ~Nov 2023

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): ISOTimestamp {
    return new Date(this.currentSeconds * 1000).toISOString() as ISOTimestamp;
  }

  set(seconds: number): void {
    this.currentSeconds = seconds;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `uuid-${this.counter}`;
  }
}

class MockAuditEmitter implements IAuthzAuditEmitter {
  readonly emittedEvents: Array<{ payload: AuthzAuditPayload; correlationId: CorrelationId }> = [];
  private eventCounter = 0;

  async emit(payload: AuthzAuditPayload, correlationId: CorrelationId): Promise<string> {
    this.eventCounter++;
    const eventId = `audit-event-${this.eventCounter}`;
    this.emittedEvents.push({ payload, correlationId });
    return eventId;
  }

  get lastEvent() {
    return this.emittedEvents[this.emittedEvents.length - 1];
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('AuthorizationService', () => {
  let service: AuthorizationService;
  let policyStore: InMemoryPolicyStore;
  let auditEmitter: MockAuditEmitter;
  let clock: MockClock;
  let idGenerator: MockIdGenerator;

  const tenantId = makeTenantId('tenant-1');
  const principalId = makePrincipalId('user-alice');
  const correlationId = makeCorrelationId('corr-1');

  beforeEach(() => {
    policyStore = new InMemoryPolicyStore();
    auditEmitter = new MockAuditEmitter();
    clock = new MockClock();
    idGenerator = new MockIdGenerator();

    service = new AuthorizationService({
      policyStore,
      auditEmitter,
      clock,
      idGenerator,
    });
  });

  // ─── Default-Deny Tests (Requirement 12.5) ─────────────────────────────────

  describe('default-deny policy', () => {
    it('should DENY when principal has no role assignments', async () => {
      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'memory',
        action: 'read',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
      expect(decision.reason).toContain('No roles assigned');
      expect(decision.audit_event_id).toBeDefined();
      expect(decision.audit_event_id).not.toBe('');
    });

    it('should DENY when principal has roles but no matching permission', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'deployment',
        action: 'execute',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
      expect(decision.reason).toContain('No explicit permission grant');
    });

    it('should DENY when resource matches but action does not', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Auditor',
      });

      // Auditor has audit:read but not audit:write
      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'audit',
        action: 'write',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
    });

    it('should DENY for unknown resource even with wildcard action role', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'nuclear_launch',
        action: 'execute',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
    });
  });

  // ─── Built-in Role Tests (Requirement 12.1) ────────────────────────────────

  describe('built-in roles', () => {
    it('should ALLOW End_User to invoke LLM', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'llm',
        action: 'invoke',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
      expect(decision.matched_policy).toBeDefined();
    });

    it('should ALLOW End_User to read memory', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'memory',
        action: 'read',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should ALLOW Tenant_Administrator to manage users', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Tenant_Administrator',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'user_management',
        action: 'create',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should ALLOW Platform_Operator to manage deployments', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Platform_Operator',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'deployment',
        action: 'execute',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should ALLOW Security_Officer to review audit', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Security_Officer',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'audit',
        action: 'read',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should ALLOW Auditor read-only audit access', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Auditor',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'audit',
        action: 'read',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should DENY Auditor write access to audit', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Auditor',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'audit',
        action: 'write',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
    });
  });

  // ─── Custom Role Tests (Requirement 12.2) ──────────────────────────────────

  describe('custom roles', () => {
    it('should ALLOW access via custom role permissions', async () => {
      const customRole: RoleDefinition = {
        name: 'DataAnalyst',
        description: 'Custom role for data analysts',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          { resource: 'analytics', action: 'read' },
          { resource: 'analytics', action: 'export' },
          { resource: 'reports', action: 'read' },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'DataAnalyst',
      });

      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'analytics',
        action: 'export',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should combine permissions from multiple roles', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      const customRole: RoleDefinition = {
        name: 'ReportViewer',
        description: 'Can view reports',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          { resource: 'reports', action: 'read' },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'ReportViewer',
      });

      // Should have End_User permissions
      const llmDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'llm',
        action: 'invoke',
        correlation_id: correlationId,
      });
      expect(llmDecision.decision).toBe('ALLOW');

      // Should also have custom role permissions
      const reportDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'reports',
        action: 'read',
        correlation_id: correlationId,
      });
      expect(reportDecision.decision).toBe('ALLOW');
    });

    it('should DENY custom role access to resources not in its grants', async () => {
      const customRole: RoleDefinition = {
        name: 'LimitedRole',
        description: 'Very limited permissions',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          { resource: 'reports', action: 'read' },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'LimitedRole',
      });

      const decision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'deployment',
        action: 'execute',
        correlation_id: correlationId,
      });

      expect(decision.decision).toBe('DENY');
    });
  });

  // ─── ABAC Condition Tests (Requirement 12.3) ───────────────────────────────

  describe('ABAC attribute conditions', () => {
    it('should ALLOW when condition is satisfied', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      // End_User has memory:delete with condition data_owner=self
      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'memory',
        action: 'delete',
        context_attributes: { data_owner: 'self' },
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('ALLOW');
    });

    it('should DENY when condition is not satisfied', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      // End_User has memory:delete with condition data_owner=self
      // but we provide data_owner=other
      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'memory',
        action: 'delete',
        context_attributes: { data_owner: 'other' },
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
    });

    it('should DENY when conditions exist but no context attributes provided', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      // memory:delete requires data_owner=self but no attributes provided
      const request: AuthzRequest = {
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'memory',
        action: 'delete',
        correlation_id: correlationId,
      };

      const decision = await service.authorize(request);

      expect(decision.decision).toBe('DENY');
    });

    it('should evaluate "in" operator correctly', async () => {
      const customRole: RoleDefinition = {
        name: 'RegionalAccess',
        description: 'Access limited to specific regions',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          {
            resource: 'data',
            action: 'read',
            conditions: [
              { attribute: 'region', operator: 'in', value: ['us-east', 'us-west', 'eu-west'] },
            ],
          },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'RegionalAccess',
      });

      // Should ALLOW for valid region
      const allowDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'data',
        action: 'read',
        context_attributes: { region: 'us-east' },
        correlation_id: correlationId,
      });
      expect(allowDecision.decision).toBe('ALLOW');

      // Should DENY for invalid region
      const denyDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'data',
        action: 'read',
        context_attributes: { region: 'ap-south' },
        correlation_id: correlationId,
      });
      expect(denyDecision.decision).toBe('DENY');
    });

    it('should evaluate "matches" operator with regex', async () => {
      const customRole: RoleDefinition = {
        name: 'BusinessHours',
        description: 'Access only during business hours',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          {
            resource: 'sensitive_data',
            action: 'read',
            conditions: [
              { attribute: 'time_period', operator: 'matches', value: '^business_hours$' },
            ],
          },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'BusinessHours',
      });

      const allowDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'sensitive_data',
        action: 'read',
        context_attributes: { time_period: 'business_hours' },
        correlation_id: correlationId,
      });
      expect(allowDecision.decision).toBe('ALLOW');

      const denyDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'sensitive_data',
        action: 'read',
        context_attributes: { time_period: 'after_hours' },
        correlation_id: correlationId,
      });
      expect(denyDecision.decision).toBe('DENY');
    });

    it('should evaluate "not_equals" operator correctly', async () => {
      const customRole: RoleDefinition = {
        name: 'NonGuestAccess',
        description: 'Access for non-guest users',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          {
            resource: 'premium',
            action: 'read',
            conditions: [
              { attribute: 'user_type', operator: 'not_equals', value: 'guest' },
            ],
          },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'NonGuestAccess',
      });

      const allowDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'premium',
        action: 'read',
        context_attributes: { user_type: 'member' },
        correlation_id: correlationId,
      });
      expect(allowDecision.decision).toBe('ALLOW');

      const denyDecision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'premium',
        action: 'read',
        context_attributes: { user_type: 'guest' },
        correlation_id: correlationId,
      });
      expect(denyDecision.decision).toBe('DENY');
    });
  });

  // ─── Audit Event Emission Tests (Requirement 12.4) ─────────────────────────

  describe('audit event emission', () => {
    it('should emit audit event on ALLOW decision', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'llm',
        action: 'invoke',
        correlation_id: correlationId,
      });

      expect(auditEmitter.emittedEvents).toHaveLength(1);
      const event = auditEmitter.lastEvent!;
      expect(event.payload.decision).toBe('ALLOW');
      expect(event.payload.principal_id).toBe(principalId);
      expect(event.payload.tenant_id).toBe(tenantId);
      expect(event.payload.resource).toBe('llm');
      expect(event.payload.action).toBe('invoke');
      expect(event.payload.roles_evaluated).toContain('End_User');
      expect(event.payload.matched_policy).toBeDefined();
      expect(event.correlationId).toBe(correlationId);
    });

    it('should emit audit event on DENY decision', async () => {
      await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'deployment',
        action: 'execute',
        correlation_id: correlationId,
      });

      expect(auditEmitter.emittedEvents).toHaveLength(1);
      const event = auditEmitter.lastEvent!;
      expect(event.payload.decision).toBe('DENY');
      expect(event.payload.principal_id).toBe(principalId);
      expect(event.payload.tenant_id).toBe(tenantId);
      expect(event.payload.resource).toBe('deployment');
      expect(event.payload.action).toBe('execute');
      expect(event.correlationId).toBe(correlationId);
    });

    it('should return audit event ID in the decision', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      const decision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'llm',
        action: 'invoke',
        correlation_id: correlationId,
      });

      expect(decision.audit_event_id).toBe('audit-event-1');
    });

    it('should emit audit event for every decision', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'End_User',
      });

      // Make multiple authorization requests
      await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'llm',
        action: 'invoke',
        correlation_id: correlationId,
      });

      await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'deployment',
        action: 'execute',
        correlation_id: makeCorrelationId('corr-2'),
      });

      expect(auditEmitter.emittedEvents).toHaveLength(2);
      expect(auditEmitter.emittedEvents[0]!.payload.decision).toBe('ALLOW');
      expect(auditEmitter.emittedEvents[1]!.payload.decision).toBe('DENY');
    });
  });

  // ─── Wildcard Pattern Tests ────────────────────────────────────────────────

  describe('wildcard pattern matching', () => {
    it('should match wildcard action "*"', async () => {
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'Tenant_Administrator',
      });

      // Tenant_Administrator has tenant_config:* (wildcard action)
      const decision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'tenant_config',
        action: 'any_action_here',
        correlation_id: correlationId,
      });

      expect(decision.decision).toBe('ALLOW');
    });

    it('should match prefix wildcard resource pattern', async () => {
      const customRole: RoleDefinition = {
        name: 'PrefixRole',
        description: 'Has prefix wildcard permissions',
        is_builtin: false,
        tenant_id: tenantId,
        permissions: [
          { resource: 'data:*', action: 'read' },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'PrefixRole',
      });

      const decision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'data:users',
        action: 'read',
        correlation_id: correlationId,
      });

      expect(decision.decision).toBe('ALLOW');
    });
  });

  // ─── Tenant Isolation Tests ────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('should not grant access from roles in a different tenant', async () => {
      const otherTenant = makeTenantId('tenant-2');

      // Assign role in tenant-2
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: otherTenant,
        role: 'Tenant_Administrator',
      });

      // Request in tenant-1 should be denied
      const decision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'tenant_config',
        action: 'read',
        correlation_id: correlationId,
      });

      expect(decision.decision).toBe('DENY');
    });

    it('should not use custom roles from a different tenant', async () => {
      const otherTenant = makeTenantId('tenant-2');

      const customRole: RoleDefinition = {
        name: 'SpecialRole',
        description: 'Special role for tenant-2',
        is_builtin: false,
        tenant_id: otherTenant,
        permissions: [
          { resource: 'special', action: 'access' },
        ],
      };

      await policyStore.addRoleDefinition(customRole);
      await policyStore.assignRole({
        principal_id: principalId,
        tenant_id: tenantId,
        role: 'SpecialRole',
      });

      // Even though role is assigned in tenant-1, the role definition
      // belongs to tenant-2, so it won't be found
      const decision = await service.authorize({
        principal_id: principalId,
        tenant_id: tenantId,
        resource: 'special',
        action: 'access',
        correlation_id: correlationId,
      });

      expect(decision.decision).toBe('DENY');
    });
  });
});
