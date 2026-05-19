/**
 * Property-based tests for authorization.
 *
 * **Validates: Requirements 12.4, 12.5**
 *
 * Property 36: Default Deny Authorization — deny when no explicit grant exists
 * Property 37: Authorization Decision Audit — every decision emits audit event with principal, resource, action, decision, policy
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@may/testing';
import { AuthorizationService } from '../../src/authorization-service.js';
import { InMemoryPolicyStore } from '../../src/in-memory-policy-store.js';
import type {
  IAuthzAuditEmitter,
  IClock,
  IIdGenerator,
  AuthzRequest,
  AuthzAuditPayload,
  RoleAssignment,
  RoleDefinition,
} from '../../src/interfaces/index.js';
import type { TenantId, PrincipalId, CorrelationId, ISOTimestamp } from '@may/types';

// ─── Stub Implementations ────────────────────────────────────────────────────

class StubClock implements IClock {
  nowSeconds(): number {
    return 1700000000;
  }

  nowISO(): ISOTimestamp {
    return new Date(1700000000 * 1000).toISOString() as ISOTimestamp;
  }
}

class StubIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `uuid-${this.counter}`;
  }
}

/**
 * A recording audit emitter that captures all emitted payloads for verification.
 */
class RecordingAuditEmitter implements IAuthzAuditEmitter {
  readonly emittedPayloads: Array<{ payload: AuthzAuditPayload; correlationId: CorrelationId }> = [];
  private counter = 0;

  async emit(payload: AuthzAuditPayload, correlationId: CorrelationId): Promise<string> {
    this.counter++;
    const eventId = `audit-event-${this.counter}`;
    this.emittedPayloads.push({ payload, correlationId });
    return eventId;
  }

  get lastPayload(): AuthzAuditPayload | undefined {
    return this.emittedPayloads[this.emittedPayloads.length - 1]?.payload;
  }

  get lastCorrelationId(): CorrelationId | undefined {
    return this.emittedPayloads[this.emittedPayloads.length - 1]?.correlationId;
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Arbitrary for resource names — generates diverse resource identifiers
 * that are unlikely to match any built-in role permissions.
 */
const nonGrantedResourceArb = fc.oneof(
  fc.constantFrom(
    'secret_vault',
    'nuclear_launch',
    'admin_panel',
    'billing_override',
    'system_shutdown',
    'data_export_all',
    'user_impersonation',
    'config_override',
    'network_firewall',
    'database_drop',
  ),
  fc.stringOf(fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '_'), { minLength: 3, maxLength: 15 }),
);

/**
 * Arbitrary for action names — generates diverse action identifiers
 * that are unlikely to match any built-in role permissions.
 */
const nonGrantedActionArb = fc.oneof(
  fc.constantFrom(
    'obliterate',
    'purge',
    'escalate',
    'bypass',
    'override',
    'impersonate',
    'nuke',
    'wipe',
    'hijack',
    'forge',
  ),
  fc.stringOf(fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '_'), { minLength: 3, maxLength: 12 }),
);

/** Arbitrary for any resource name (used in Property 37 for both ALLOW and DENY paths). */
const anyResourceArb = fc.oneof(
  nonGrantedResourceArb,
  fc.constantFrom('llm', 'memory', 'action', 'workflow', 'audit', 'tenant_config', 'deployment'),
);

/** Arbitrary for any action name (used in Property 37 for both ALLOW and DENY paths). */
const anyActionArb = fc.oneof(
  nonGrantedActionArb,
  fc.constantFrom('read', 'write', 'delete', 'execute', 'invoke', 'stream', 'configure'),
);

/** Arbitrary for tenant IDs. */
const tenantIdArb = fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '3', '-'), { minLength: 5, maxLength: 15 })
  .map((s) => `tenant-${s}` as unknown as TenantId);

/** Arbitrary for principal IDs. */
const principalIdArb = fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '3', '-'), { minLength: 5, maxLength: 15 })
  .map((s) => `principal-${s}` as unknown as PrincipalId);

/** Arbitrary for correlation IDs. */
const correlationIdArb = fc.uuid().map((s) => s as unknown as CorrelationId);

/** Arbitrary for built-in role names. */
const builtInRoleArb = fc.constantFrom(
  'End_User',
  'Tenant_Administrator',
  'Platform_Operator',
  'Security_Officer',
  'Auditor',
);

// ─── Property 36: Default Deny Authorization ─────────────────────────────────

describe('Property 36: Default Deny Authorization', () => {
  /**
   * **Validates: Requirements 12.5**
   *
   * For ANY principal with NO role assignments, the authorization decision
   * MUST be DENY regardless of the resource and action requested.
   */
  it('denies access when principal has no role assignments', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalIdArb,
        tenantIdArb,
        anyResourceArb,
        anyActionArb,
        correlationIdArb,
        async (principalId, tenantId, resource, action, correlationId) => {
          const policyStore = new InMemoryPolicyStore();
          const auditEmitter = new RecordingAuditEmitter();
          const clock = new StubClock();
          const idGenerator = new StubIdGenerator();

          const service = new AuthorizationService({
            policyStore,
            auditEmitter,
            clock,
            idGenerator,
          });

          // Principal has NO role assignments — no assignRole called
          const request: AuthzRequest = {
            principal_id: principalId,
            tenant_id: tenantId,
            resource,
            action,
            correlation_id: correlationId,
          };

          const decision = await service.authorize(request);

          // Default-deny: must be DENY
          expect(decision.decision).toBe('DENY');
          expect(decision.reason).toContain('No roles assigned');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 12.5**
   *
   * For ANY principal with roles assigned, but requesting a resource+action
   * that is NOT granted by any of those roles, the decision MUST be DENY.
   */
  it('denies access when assigned roles do not grant the requested resource+action', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalIdArb,
        tenantIdArb,
        builtInRoleArb,
        nonGrantedResourceArb,
        nonGrantedActionArb,
        correlationIdArb,
        async (principalId, tenantId, roleName, resource, action, correlationId) => {
          const policyStore = new InMemoryPolicyStore();
          const auditEmitter = new RecordingAuditEmitter();
          const clock = new StubClock();
          const idGenerator = new StubIdGenerator();

          // Assign a role to the principal
          const assignment: RoleAssignment = {
            principal_id: principalId,
            tenant_id: tenantId,
            role: roleName,
          };
          await policyStore.assignRole(assignment);

          const service = new AuthorizationService({
            policyStore,
            auditEmitter,
            clock,
            idGenerator,
          });

          const request: AuthzRequest = {
            principal_id: principalId,
            tenant_id: tenantId,
            resource,
            action,
            correlation_id: correlationId,
          };

          const decision = await service.authorize(request);

          // Default-deny: resource+action not in any role's grants → DENY
          expect(decision.decision).toBe('DENY');
          expect(decision.reason).toContain('No explicit permission grant');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 12.5**
   *
   * For a principal with a custom role that has NO permissions,
   * the decision MUST be DENY for any resource+action.
   */
  it('denies access when custom role has empty permissions', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalIdArb,
        tenantIdArb,
        anyResourceArb,
        anyActionArb,
        correlationIdArb,
        async (principalId, tenantId, resource, action, correlationId) => {
          const policyStore = new InMemoryPolicyStore();
          const auditEmitter = new RecordingAuditEmitter();
          const clock = new StubClock();
          const idGenerator = new StubIdGenerator();

          // Create a custom role with NO permissions
          const emptyRole: RoleDefinition = {
            name: 'EmptyRole',
            description: 'A role with no permissions',
            is_builtin: false,
            tenant_id: tenantId,
            permissions: [],
          };
          await policyStore.addRoleDefinition(emptyRole);
          await policyStore.assignRole({
            principal_id: principalId,
            tenant_id: tenantId,
            role: 'EmptyRole',
          });

          const service = new AuthorizationService({
            policyStore,
            auditEmitter,
            clock,
            idGenerator,
          });

          const request: AuthzRequest = {
            principal_id: principalId,
            tenant_id: tenantId,
            resource,
            action,
            correlation_id: correlationId,
          };

          const decision = await service.authorize(request);

          // Empty role → no grants → DENY
          expect(decision.decision).toBe('DENY');
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 37: Authorization Decision Audit ───────────────────────────────

describe('Property 37: Authorization Decision Audit', () => {
  /**
   * **Validates: Requirements 12.4**
   *
   * For ANY authorization request resulting in DENY, an audit event MUST be
   * emitted containing: principal_id, resource, action, decision, and the
   * audit_event_id in the decision must be non-empty.
   */
  it('emits audit event with correct fields on DENY decisions', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalIdArb,
        tenantIdArb,
        anyResourceArb,
        anyActionArb,
        correlationIdArb,
        async (principalId, tenantId, resource, action, correlationId) => {
          const policyStore = new InMemoryPolicyStore();
          const auditEmitter = new RecordingAuditEmitter();
          const clock = new StubClock();
          const idGenerator = new StubIdGenerator();

          const service = new AuthorizationService({
            policyStore,
            auditEmitter,
            clock,
            idGenerator,
          });

          // No roles assigned → guaranteed DENY
          const request: AuthzRequest = {
            principal_id: principalId,
            tenant_id: tenantId,
            resource,
            action,
            correlation_id: correlationId,
          };

          const decision = await service.authorize(request);

          // Verify audit event was emitted
          expect(auditEmitter.emittedPayloads.length).toBeGreaterThan(0);

          const lastEmission = auditEmitter.emittedPayloads[auditEmitter.emittedPayloads.length - 1];
          const payload = lastEmission.payload;

          // Verify all required fields are present and correct
          expect(payload.principal_id).toBe(principalId as string);
          expect(payload.tenant_id).toBe(tenantId as string);
          expect(payload.resource).toBe(resource);
          expect(payload.action).toBe(action);
          expect(payload.decision).toBe('DENY');
          expect(payload.reason).toBeTruthy();
          expect(payload.roles_evaluated).toBeDefined();
          expect(Array.isArray(payload.roles_evaluated)).toBe(true);

          // Verify correlation ID was passed through
          expect(lastEmission.correlationId).toBe(correlationId);

          // Verify audit_event_id is non-empty in the decision
          expect(decision.audit_event_id).toBeTruthy();
          expect(decision.audit_event_id.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 12.4**
   *
   * For ANY authorization request resulting in ALLOW, an audit event MUST be
   * emitted containing: principal_id, resource, action, decision, matched_policy,
   * and the audit_event_id in the decision must be non-empty.
   */
  it('emits audit event with correct fields and matched_policy on ALLOW decisions', async () => {
    // Generate requests that will result in ALLOW by using known granted resource+action pairs
    const grantedPairArb = fc.constantFrom(
      { resource: 'llm', action: 'invoke', role: 'End_User' },
      { resource: 'memory', action: 'read', role: 'End_User' },
      { resource: 'memory', action: 'write', role: 'End_User' },
      { resource: 'audit', action: 'read', role: 'Tenant_Administrator' },
      { resource: 'audit', action: 'read', role: 'Auditor' },
      { resource: 'audit', action: 'verify', role: 'Auditor' },
      { resource: 'deployment', action: 'read', role: 'Platform_Operator' },
      { resource: 'compliance', action: 'read', role: 'Security_Officer' },
      { resource: 'voice', action: 'transcribe', role: 'End_User' },
      { resource: 'workflow', action: 'create', role: 'End_User' },
    );

    await fc.assert(
      fc.asyncProperty(
        principalIdArb,
        tenantIdArb,
        grantedPairArb,
        correlationIdArb,
        async (principalId, tenantId, grantedPair, correlationId) => {
          const policyStore = new InMemoryPolicyStore();
          const auditEmitter = new RecordingAuditEmitter();
          const clock = new StubClock();
          const idGenerator = new StubIdGenerator();

          // Assign the role that grants the resource+action
          await policyStore.assignRole({
            principal_id: principalId,
            tenant_id: tenantId,
            role: grantedPair.role,
          });

          const service = new AuthorizationService({
            policyStore,
            auditEmitter,
            clock,
            idGenerator,
          });

          const request: AuthzRequest = {
            principal_id: principalId,
            tenant_id: tenantId,
            resource: grantedPair.resource,
            action: grantedPair.action,
            correlation_id: correlationId,
          };

          const decision = await service.authorize(request);

          // Should be ALLOW
          expect(decision.decision).toBe('ALLOW');

          // Verify audit event was emitted
          expect(auditEmitter.emittedPayloads.length).toBeGreaterThan(0);

          const lastEmission = auditEmitter.emittedPayloads[auditEmitter.emittedPayloads.length - 1];
          const payload = lastEmission.payload;

          // Verify all required fields are present and correct
          expect(payload.principal_id).toBe(principalId as string);
          expect(payload.tenant_id).toBe(tenantId as string);
          expect(payload.resource).toBe(grantedPair.resource);
          expect(payload.action).toBe(grantedPair.action);
          expect(payload.decision).toBe('ALLOW');
          expect(payload.reason).toBeTruthy();
          expect(payload.matched_policy).toBeTruthy();
          expect(payload.roles_evaluated).toBeDefined();
          expect(Array.isArray(payload.roles_evaluated)).toBe(true);
          expect(payload.roles_evaluated).toContain(grantedPair.role);

          // Verify correlation ID was passed through
          expect(lastEmission.correlationId).toBe(correlationId);

          // Verify audit_event_id is non-empty in the decision
          expect(decision.audit_event_id).toBeTruthy();
          expect(decision.audit_event_id.length).toBeGreaterThan(0);

          // Verify matched_policy is present in the decision
          expect(decision.matched_policy).toBeTruthy();
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 12.4**
   *
   * For ANY authorization request (ALLOW or DENY), exactly one audit event
   * is emitted per authorize() call.
   */
  it('emits exactly one audit event per authorization decision', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalIdArb,
        tenantIdArb,
        anyResourceArb,
        anyActionArb,
        correlationIdArb,
        fc.boolean(),
        async (principalId, tenantId, resource, action, correlationId, assignRole) => {
          const policyStore = new InMemoryPolicyStore();
          const auditEmitter = new RecordingAuditEmitter();
          const clock = new StubClock();
          const idGenerator = new StubIdGenerator();

          // Optionally assign a role to get a mix of ALLOW and DENY
          if (assignRole) {
            await policyStore.assignRole({
              principal_id: principalId,
              tenant_id: tenantId,
              role: 'End_User',
            });
          }

          const service = new AuthorizationService({
            policyStore,
            auditEmitter,
            clock,
            idGenerator,
          });

          const countBefore = auditEmitter.emittedPayloads.length;

          await service.authorize({
            principal_id: principalId,
            tenant_id: tenantId,
            resource,
            action,
            correlation_id: correlationId,
          });

          const countAfter = auditEmitter.emittedPayloads.length;

          // Exactly one audit event emitted per call
          expect(countAfter - countBefore).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
