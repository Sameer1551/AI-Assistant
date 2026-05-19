/**
 * @module authorization-service
 * RBAC/ABAC authorization engine implementation.
 *
 * Implements the IAuthorizationService interface with:
 * - Role-based access control (RBAC) with built-in and custom roles
 * - Attribute-based access control (ABAC) with condition evaluation
 * - Default-deny policy: no explicit grant = DENY
 * - Audit event emission for every authorization decision
 *
 * @see Requirement 12.1 - Built-in roles (End_User, Tenant_Administrator, Platform_Operator, Security_Officer, Auditor)
 * @see Requirement 12.2 - Custom role definitions with explicit permission grants
 * @see Requirement 12.3 - Role + attribute evaluation
 * @see Requirement 12.4 - Authorization decision audit events
 * @see Requirement 12.5 - Default-deny policy
 */

import type { TenantId } from '@may/types';
import type {
  IAuthorizationService,
  IPolicyStore,
  IAuthzAuditEmitter,
  IClock,
  IIdGenerator,
  AuthzRequest,
  AuthzDecision,
  RoleDefinition,
  PermissionGrant,
  AttributeCondition,
} from './interfaces/index.js';

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Dependencies required by the AuthorizationService.
 * All external dependencies are injected for testability.
 */
export interface AuthorizationServiceDependencies {
  /** Policy store for loading role definitions and assignments. */
  readonly policyStore: IPolicyStore;
  /** Audit emitter for authorization decision events. */
  readonly auditEmitter: IAuthzAuditEmitter;
  /** Clock abstraction for testable time-dependent logic (used in ABAC time conditions). */
  readonly clock: IClock;
  /** ID generator for creating unique identifiers. */
  readonly idGenerator: IIdGenerator;
}

// ─── AuthorizationService Implementation ─────────────────────────────────────

/**
 * Production implementation of the RBAC/ABAC authorization engine.
 *
 * Policy evaluation flow:
 * 1. Resolve the principal's role assignments in the tenant
 * 2. Load role definitions for each assigned role
 * 3. Collect all permission grants from those roles
 * 4. Match grants against the requested resource + action
 * 5. Evaluate ABAC conditions on matching grants
 * 6. If any grant fully matches → ALLOW; otherwise → DENY (default-deny)
 * 7. Emit an audit event for the decision
 *
 * @see Requirement 12.5 - Default-deny: if no policy explicitly grants access, decision is DENY
 */
export class AuthorizationService implements IAuthorizationService {
  private readonly policyStore: IPolicyStore;
  private readonly auditEmitter: IAuthzAuditEmitter;
  private readonly clock: IClock;
  private readonly idGenerator: IIdGenerator;

  constructor(deps: AuthorizationServiceDependencies) {
    this.policyStore = deps.policyStore;
    this.auditEmitter = deps.auditEmitter;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
  }

  /**
   * Evaluate an authorization request and return a decision.
   *
   * Implements default-deny: if no explicit permission grant matches
   * the requested resource + action + conditions, the decision is DENY.
   *
   * Every decision (ALLOW or DENY) emits an audit event per Requirement 12.4.
   *
   * @param request - The authorization request containing principal, resource, action, and context
   * @returns The authorization decision with audit trail
   */
  async authorize(request: AuthzRequest): Promise<AuthzDecision> {
    const { principal_id, tenant_id, resource, action, context_attributes, correlation_id } = request;

    // Enrich context attributes with current time for time-based ABAC conditions
    const enrichedAttributes = this.enrichContextAttributes(context_attributes);

    // Step 1: Resolve the principal's role assignments
    const roleAssignments = await this.policyStore.getRoleAssignments(principal_id, tenant_id);
    const roleNames = roleAssignments.map((a) => a.role);

    // Step 2: Load role definitions for each assigned role
    const roleDefinitions = await this.resolveRoleDefinitions(roleNames, tenant_id);

    // Step 3: Collect all permission grants from resolved roles
    const allGrants = roleDefinitions.flatMap((role) => role.permissions);

    // Step 4 & 5: Match grants against resource + action + conditions
    const matchResult = this.findMatchingGrant(allGrants, resource, action, enrichedAttributes);

    // Step 6: Build decision
    let decision: AuthzDecision;

    if (matchResult) {
      decision = {
        decision: 'ALLOW',
        reason: `Permission granted by policy: ${matchResult.policyDescription}`,
        matched_policy: matchResult.policyDescription,
        audit_event_id: '', // Will be set after audit emission
      };
    } else {
      decision = {
        decision: 'DENY',
        reason: roleNames.length === 0
          ? 'No roles assigned to principal'
          : `No explicit permission grant for resource '${resource}' action '${action}'`,
        audit_event_id: '', // Will be set after audit emission
      };
    }

    // Step 7: Emit audit event
    const auditEventId = await this.auditEmitter.emit(
      {
        principal_id: principal_id as string,
        tenant_id: tenant_id as string,
        resource,
        action,
        decision: decision.decision,
        reason: decision.reason,
        matched_policy: decision.matched_policy,
        roles_evaluated: roleNames,
        context_attributes,
      },
      correlation_id,
    );

    // Return decision with audit event ID
    return {
      ...decision,
      audit_event_id: auditEventId,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve role definitions from role names.
   * Skips roles that don't have a definition (graceful degradation).
   */
  private async resolveRoleDefinitions(
    roleNames: readonly string[],
    tenantId: TenantId,
  ): Promise<readonly RoleDefinition[]> {
    const definitions: RoleDefinition[] = [];

    for (const roleName of roleNames) {
      const definition = await this.policyStore.getRoleDefinition(roleName, tenantId);
      if (definition) {
        definitions.push(definition);
      }
    }

    return definitions;
  }

  /**
   * Find a matching permission grant for the requested resource + action.
   *
   * A grant matches if:
   * 1. The grant's resource matches the requested resource (exact or wildcard)
   * 2. The grant's action matches the requested action (exact or wildcard)
   * 3. All ABAC conditions on the grant are satisfied by the context attributes
   *
   * @returns The matching grant description, or null if no grant matches (default-deny)
   */
  private findMatchingGrant(
    grants: readonly PermissionGrant[],
    resource: string,
    action: string,
    contextAttributes?: Readonly<Record<string, string>>,
  ): { policyDescription: string } | null {
    for (const grant of grants) {
      // Check resource match
      if (!this.matchesPattern(grant.resource, resource)) {
        continue;
      }

      // Check action match
      if (!this.matchesPattern(grant.action, action)) {
        continue;
      }

      // Check ABAC conditions
      if (grant.conditions && grant.conditions.length > 0) {
        if (!this.evaluateConditions(grant.conditions, contextAttributes)) {
          continue;
        }
      }

      // Grant matches
      return {
        policyDescription: `${grant.resource}:${grant.action}${grant.conditions ? ' [conditional]' : ''}`,
      };
    }

    // No grant matched — default-deny
    return null;
  }

  /**
   * Match a pattern against a value.
   * Supports:
   * - Exact match: "memory" matches "memory"
   * - Wildcard: "*" matches anything
   * - Prefix wildcard: "memory:*" matches "memory:read", "memory:write"
   */
  private matchesPattern(pattern: string, value: string): boolean {
    if (pattern === '*') {
      return true;
    }

    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2);
      return value === prefix || value.startsWith(prefix + ':');
    }

    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return value.startsWith(prefix);
    }

    return pattern === value;
  }

  /**
   * Evaluate all ABAC conditions against the provided context attributes.
   * All conditions must be satisfied (AND logic).
   *
   * @returns true if all conditions are satisfied, false otherwise
   */
  private evaluateConditions(
    conditions: readonly AttributeCondition[],
    contextAttributes?: Readonly<Record<string, string>>,
  ): boolean {
    if (!contextAttributes) {
      // If conditions exist but no context attributes provided, conditions cannot be satisfied
      return false;
    }

    for (const condition of conditions) {
      const attributeValue = contextAttributes[condition.attribute];

      if (!this.evaluateCondition(condition, attributeValue)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Evaluate a single ABAC condition.
   */
  private evaluateCondition(condition: AttributeCondition, attributeValue: string | undefined): boolean {
    const { operator, value } = condition;

    switch (operator) {
      case 'equals':
        return attributeValue === value;

      case 'not_equals':
        return attributeValue !== value;

      case 'in': {
        if (!attributeValue) return false;
        const allowedValues = Array.isArray(value) ? value : [value];
        return allowedValues.includes(attributeValue);
      }

      case 'not_in': {
        if (!attributeValue) return true; // undefined is not in any set
        const disallowedValues = Array.isArray(value) ? value : [value];
        return !disallowedValues.includes(attributeValue);
      }

      case 'matches': {
        if (!attributeValue) return false;
        try {
          const regex = new RegExp(value as string);
          return regex.test(attributeValue);
        } catch {
          // Invalid regex — condition fails
          return false;
        }
      }

      default:
        return false;
    }
  }

  /**
   * Enrich context attributes with system-derived values.
   * Adds current time information for time-based ABAC conditions
   * (e.g., "only during business hours") without overwriting
   * explicitly provided attributes.
   */
  private enrichContextAttributes(
    contextAttributes?: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const nowSeconds = this.clock.nowSeconds();
    const date = new Date(nowSeconds * 1000);
    const hour = date.getUTCHours().toString();
    const dayOfWeek = date.getUTCDay().toString();

    const systemAttributes: Record<string, string> = {
      _current_hour_utc: hour,
      _current_day_of_week: dayOfWeek,
      _request_id: this.idGenerator.uuid(),
    };

    if (!contextAttributes) {
      return systemAttributes;
    }

    // User-provided attributes take precedence over system-derived ones
    return { ...systemAttributes, ...contextAttributes };
  }
}
