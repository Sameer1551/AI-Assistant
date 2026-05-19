/**
 * @module in-memory-policy-store
 * In-memory implementation of IPolicyStore for testing and development.
 *
 * This implementation is clearly marked as swappable — production deployments
 * should use a database-backed or policy-engine-backed implementation.
 *
 * Pre-loaded with built-in role definitions per Requirement 12.1.
 */

import type { TenantId, PrincipalId } from '@may/types';
import type {
  IPolicyStore,
  RoleDefinition,
  RoleAssignment,
  PermissionGrant,
  BuiltInRole,
} from './interfaces/index.js';

// ─── Built-in Role Definitions ───────────────────────────────────────────────

/**
 * End_User: basic platform usage permissions.
 * - Invoke LLM, execute actions, manage own memory.
 */
const END_USER_PERMISSIONS: readonly PermissionGrant[] = [
  { resource: 'llm', action: 'invoke' },
  { resource: 'llm', action: 'stream' },
  { resource: 'memory', action: 'read' },
  { resource: 'memory', action: 'write' },
  { resource: 'memory', action: 'delete', conditions: [{ attribute: 'data_owner', operator: 'equals', value: 'self' }] },
  { resource: 'action', action: 'execute' },
  { resource: 'action', action: 'status' },
  { resource: 'workflow', action: 'create' },
  { resource: 'workflow', action: 'read' },
  { resource: 'workflow', action: 'pause' },
  { resource: 'workflow', action: 'cancel' },
  { resource: 'habit', action: 'read' },
  { resource: 'habit', action: 'delete' },
  { resource: 'emotion', action: 'read' },
  { resource: 'context', action: 'read' },
  { resource: 'cognitive_state', action: 'read' },
  { resource: 'code_sandbox', action: 'execute' },
  { resource: 'voice', action: 'transcribe' },
  { resource: 'voice', action: 'synthesize' },
  { resource: 'consent', action: 'read' },
  { resource: 'consent', action: 'write' },
  { resource: 'goal', action: 'read' },
  { resource: 'goal', action: 'write' },
  { resource: 'intent_graph', action: 'read' },
  { resource: 'intent_graph', action: 'write' },
];

/**
 * Tenant_Administrator: tenant configuration, user management, policy management.
 */
const TENANT_ADMIN_PERMISSIONS: readonly PermissionGrant[] = [
  { resource: 'tenant_config', action: '*' },
  { resource: 'user_management', action: '*' },
  { resource: 'policy', action: '*' },
  { resource: 'role', action: '*' },
  { resource: 'consent', action: '*' },
  { resource: 'budget', action: '*' },
  { resource: 'integration', action: '*' },
  { resource: 'retention', action: '*' },
  { resource: 'residency', action: '*' },
  { resource: 'model_registry', action: 'read' },
  { resource: 'model_registry', action: 'configure' },
  { resource: 'audit', action: 'read' },
  { resource: 'cost', action: 'read' },
  { resource: 'cost', action: 'configure' },
];

/**
 * Platform_Operator: deployment, infrastructure, monitoring.
 */
const PLATFORM_OPERATOR_PERMISSIONS: readonly PermissionGrant[] = [
  { resource: 'deployment', action: '*' },
  { resource: 'infrastructure', action: '*' },
  { resource: 'monitoring', action: '*' },
  { resource: 'telemetry', action: '*' },
  { resource: 'service_health', action: '*' },
  { resource: 'canary', action: '*' },
  { resource: 'model_registry', action: '*' },
  { resource: 'secrets', action: 'rotate' },
  { resource: 'secrets', action: 'read' },
  { resource: 'resource_governor', action: '*' },
  { resource: 'compute_fabric', action: '*' },
  { resource: 'watchdog', action: '*' },
];

/**
 * Security_Officer: audit review, security policy, compliance.
 */
const SECURITY_OFFICER_PERMISSIONS: readonly PermissionGrant[] = [
  { resource: 'audit', action: '*' },
  { resource: 'security_policy', action: '*' },
  { resource: 'compliance', action: '*' },
  { resource: 'governance', action: '*' },
  { resource: 'dsar', action: '*' },
  { resource: 'secrets', action: 'revoke' },
  { resource: 'secrets', action: 'read' },
  { resource: 'break_glass', action: 'approve' },
  { resource: 'siem', action: 'configure' },
];

/**
 * Auditor: read-only audit access.
 */
const AUDITOR_PERMISSIONS: readonly PermissionGrant[] = [
  { resource: 'audit', action: 'read' },
  { resource: 'audit', action: 'verify' },
  { resource: 'audit', action: 'export' },
  { resource: 'compliance', action: 'read' },
  { resource: 'cost', action: 'read' },
];

/**
 * Map of built-in role names to their permission sets.
 */
const BUILT_IN_ROLE_PERMISSIONS: Record<BuiltInRole, readonly PermissionGrant[]> = {
  End_User: END_USER_PERMISSIONS,
  Tenant_Administrator: TENANT_ADMIN_PERMISSIONS,
  Platform_Operator: PLATFORM_OPERATOR_PERMISSIONS,
  Security_Officer: SECURITY_OFFICER_PERMISSIONS,
  Auditor: AUDITOR_PERMISSIONS,
};

/**
 * Create built-in role definitions.
 */
function createBuiltInRoles(): readonly RoleDefinition[] {
  return [
    {
      name: 'End_User',
      description: 'Basic platform usage: invoke LLM, execute actions, manage own memory',
      is_builtin: true,
      permissions: END_USER_PERMISSIONS,
    },
    {
      name: 'Tenant_Administrator',
      description: 'Tenant configuration, user management, and policy management',
      is_builtin: true,
      permissions: TENANT_ADMIN_PERMISSIONS,
    },
    {
      name: 'Platform_Operator',
      description: 'Deployment, infrastructure management, and monitoring',
      is_builtin: true,
      permissions: PLATFORM_OPERATOR_PERMISSIONS,
    },
    {
      name: 'Security_Officer',
      description: 'Audit review, security policy, and compliance management',
      is_builtin: true,
      permissions: SECURITY_OFFICER_PERMISSIONS,
    },
    {
      name: 'Auditor',
      description: 'Read-only audit access for compliance verification',
      is_builtin: true,
      permissions: AUDITOR_PERMISSIONS,
    },
  ];
}

// ─── InMemoryPolicyStore ─────────────────────────────────────────────────────

/**
 * In-memory implementation of IPolicyStore.
 *
 * ⚠️ FOR TESTING AND DEVELOPMENT ONLY.
 * Production deployments should use a database-backed implementation.
 *
 * Pre-loaded with built-in role definitions per Requirement 12.1.
 */
export class InMemoryPolicyStore implements IPolicyStore {
  private readonly customRoles: Map<string, RoleDefinition> = new Map();
  private readonly roleAssignments: RoleAssignment[] = [];
  private readonly builtInRoles: readonly RoleDefinition[];

  constructor() {
    this.builtInRoles = createBuiltInRoles();
  }

  /**
   * Get all role definitions available for a tenant.
   * Returns built-in roles plus any custom roles defined for the tenant.
   */
  async getRoleDefinitions(tenantId: TenantId): Promise<readonly RoleDefinition[]> {
    const customForTenant = Array.from(this.customRoles.values()).filter(
      (role) => role.tenant_id === tenantId,
    );
    return [...this.builtInRoles, ...customForTenant];
  }

  /**
   * Get a specific role definition by name.
   * Checks built-in roles first, then tenant-specific custom roles.
   */
  async getRoleDefinition(roleName: string, tenantId: TenantId): Promise<RoleDefinition | null> {
    // Check built-in roles first
    const builtIn = this.builtInRoles.find((r) => r.name === roleName);
    if (builtIn) {
      return builtIn;
    }

    // Check custom roles for this tenant
    const key = `${tenantId}:${roleName}`;
    return this.customRoles.get(key) ?? null;
  }

  /**
   * Get all role assignments for a principal in a tenant.
   */
  async getRoleAssignments(principalId: PrincipalId, tenantId: TenantId): Promise<readonly RoleAssignment[]> {
    return this.roleAssignments.filter(
      (a) => a.principal_id === principalId && a.tenant_id === tenantId,
    );
  }

  /**
   * Add a custom role definition for a tenant.
   */
  async addRoleDefinition(role: RoleDefinition): Promise<void> {
    if (role.is_builtin) {
      throw new Error('Cannot add built-in roles through addRoleDefinition');
    }
    if (!role.tenant_id) {
      throw new Error('Custom roles must have a tenant_id');
    }
    const key = `${role.tenant_id}:${role.name}`;
    this.customRoles.set(key, role);
  }

  /**
   * Assign a role to a principal in a tenant.
   */
  async assignRole(assignment: RoleAssignment): Promise<void> {
    // Prevent duplicate assignments
    const exists = this.roleAssignments.some(
      (a) =>
        a.principal_id === assignment.principal_id &&
        a.tenant_id === assignment.tenant_id &&
        a.role === assignment.role,
    );
    if (!exists) {
      this.roleAssignments.push(assignment);
    }
  }

  /**
   * Remove a role assignment from a principal.
   */
  async removeRoleAssignment(principalId: PrincipalId, roleName: string, tenantId: TenantId): Promise<void> {
    const index = this.roleAssignments.findIndex(
      (a) => a.principal_id === principalId && a.role === roleName && a.tenant_id === tenantId,
    );
    if (index >= 0) {
      this.roleAssignments.splice(index, 1);
    }
  }
}

export { BUILT_IN_ROLE_PERMISSIONS, createBuiltInRoles };
