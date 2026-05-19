/**
 * Identity service interfaces.
 * Service contracts and dependency injection interfaces for token issuance,
 * validation, OIDC federation, RBAC/ABAC authorization, Confirmation_Challenge
 * issuance/validation, service-to-service authentication, and break-glass
 * emergency access.
 */

import type {
  TenantId,
  PrincipalId,
  SessionId,
  CorrelationId,
  ISOTimestamp,
  PlatformError,
} from '@may/types';

// Re-export service authentication interfaces
export type {
  ServiceCertificate,
  ServiceIdentity,
  BreakGlassRequest,
  BreakGlassGrant,
  BreakGlassApproval,
  IServiceAuthenticator,
  IBreakGlassManager,
  IAuditEmitter,
  ITrustDomainRegistry,
  ICertificateRevocationChecker,
  IServiceCallPolicy,
} from './service-auth.js';

// ─── Token Claims ────────────────────────────────────────────────────────────

/**
 * Standard claims embedded in platform access and refresh tokens.
 */
export interface TokenClaims {
  /** Subject — the authenticated principal identifier. */
  readonly sub: PrincipalId;
  /** Tenant identifier — cryptographic tenant boundary. */
  readonly tenant_id: TenantId;
  /** Resolved roles for the principal within this tenant. */
  readonly roles: readonly string[];
  /** Session identifier binding the token to a specific auth session. */
  readonly session_id: SessionId;
  /** Issued-at timestamp (Unix epoch seconds). */
  readonly iat: number;
  /** Expiration timestamp (Unix epoch seconds). */
  readonly exp: number;
  /** Audience — intended recipient(s) of the token. */
  readonly aud: string;
  /** JWT ID — unique token identifier for revocation tracking. */
  readonly jti: string;
}

// ─── Request/Response Types ──────────────────────────────────────────────────

/**
 * Authentication request — credentials or OIDC token exchange.
 */
export interface AuthRequest {
  /** Tenant context for the authentication attempt. */
  readonly tenant_id: TenantId;
  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
  /** Credential type: 'password', 'oidc_token', or 'client_credentials'. */
  readonly grant_type: 'password' | 'oidc_token' | 'client_credentials';
  /** Username for password grant. */
  readonly username?: string;
  /** Password for password grant. */
  readonly password?: string;
  /** External OIDC ID token for federation. */
  readonly id_token?: string;
  /** Client ID for client_credentials grant. */
  readonly client_id?: string;
  /** Client secret for client_credentials grant. */
  readonly client_secret?: string;
  /** Requested audience for the issued token. */
  readonly audience: string;
}

/**
 * Token response returned on successful authentication or refresh.
 */
export interface TokenResponse {
  /** The issued access token (JWT). */
  readonly access_token: string;
  /** The issued refresh token (opaque or JWT). */
  readonly refresh_token: string;
  /** Token type — always 'Bearer'. */
  readonly token_type: 'Bearer';
  /** Access token lifetime in seconds. */
  readonly expires_in: number;
  /** Refresh token lifetime in seconds. */
  readonly refresh_expires_in: number;
  /** The session identifier for this token pair. */
  readonly session_id: SessionId;
}

/**
 * Refresh token request.
 */
export interface RefreshRequest {
  /** The refresh token to exchange. */
  readonly refresh_token: string;
  /** Tenant context. */
  readonly tenant_id: TenantId;
  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
  /** Requested audience for the new access token. */
  readonly audience: string;
}

/**
 * Token validation request.
 */
export interface TokenValidationRequest {
  /** The token to validate. */
  readonly token: string;
  /** Expected audience — validation fails if token audience doesn't match. */
  readonly expected_audience: string;
  /** Tenant context. */
  readonly tenant_id: TenantId;
  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
}

/**
 * Result of token validation.
 */
export interface ValidationResult {
  /** Whether the token is valid. */
  readonly valid: boolean;
  /** Decoded claims if valid, undefined otherwise. */
  readonly claims?: TokenClaims;
  /** Reason for invalidity if not valid. */
  readonly reason?: 'INVALID_SIGNATURE' | 'EXPIRED' | 'AUDIENCE_MISMATCH' | 'REVOKED' | 'MALFORMED';
}

// ─── Service Interfaces ──────────────────────────────────────────────────────

/**
 * Token service — issues, refreshes, and validates platform tokens.
 *
 * Implements the Authenticate, RefreshToken, and ValidateToken RPCs
 * from the Identity_Service gRPC definition.
 */
export interface ITokenService {
  /**
   * Authenticate a principal and issue access + refresh tokens.
   *
   * @param request - Authentication request with credentials or OIDC token
   * @returns Token response on success
   * @throws PlatformError with category AUTHENTICATION on failure
   */
  authenticate(request: AuthRequest): Promise<TokenResponse>;

  /**
   * Exchange a valid refresh token for a new access + refresh token pair.
   *
   * @param request - Refresh request containing the refresh token
   * @returns New token response on success
   * @throws PlatformError with category AUTHENTICATION if refresh token is invalid/expired/revoked
   */
  refreshToken(request: RefreshRequest): Promise<TokenResponse>;

  /**
   * Validate a token's signature, audience, expiry, and revocation status.
   *
   * @param request - Validation request with the token and expected audience
   * @returns Validation result indicating validity and decoded claims
   */
  validateToken(request: TokenValidationRequest): Promise<ValidationResult>;
}

// ─── Dependency Interfaces ───────────────────────────────────────────────────

/**
 * Clock abstraction for testable time-dependent logic.
 */
export interface IClock {
  /** Returns the current time as Unix epoch seconds. */
  nowSeconds(): number;
  /** Returns the current time as an ISO 8601 timestamp string. */
  nowISO(): ISOTimestamp;
}

/**
 * Cryptographic operations for token signing and verification.
 */
export interface ITokenCrypto {
  /**
   * Sign a token payload and return the complete JWT string.
   *
   * @param payload - The claims to encode in the token
   * @param keyId - Identifier of the signing key to use
   * @returns The signed JWT string
   */
  sign(payload: Record<string, unknown>, keyId: string): Promise<string>;

  /**
   * Verify a JWT signature and decode the payload.
   *
   * @param token - The JWT string to verify
   * @returns Decoded payload if signature is valid, null if invalid
   */
  verify(token: string): Promise<Record<string, unknown> | null>;
}

/**
 * Token store for managing refresh tokens and revocation state.
 */
export interface ITokenStore {
  /**
   * Store a refresh token record.
   *
   * @param jti - Unique token identifier
   * @param record - Token metadata to store
   */
  storeRefreshToken(jti: string, record: RefreshTokenRecord): Promise<void>;

  /**
   * Retrieve a refresh token record by its JTI.
   *
   * @param jti - Unique token identifier
   * @returns The stored record, or null if not found
   */
  getRefreshToken(jti: string): Promise<RefreshTokenRecord | null>;

  /**
   * Revoke a token by its JTI (marks it as revoked).
   *
   * @param jti - Unique token identifier to revoke
   */
  revokeToken(jti: string): Promise<void>;

  /**
   * Check if a token JTI has been revoked.
   *
   * @param jti - Unique token identifier to check
   * @returns True if the token has been revoked
   */
  isRevoked(jti: string): Promise<boolean>;

  /**
   * Revoke all tokens for a given session.
   *
   * @param sessionId - Session identifier whose tokens should be revoked
   */
  revokeSession(sessionId: SessionId): Promise<void>;
}

/**
 * Stored metadata for a refresh token.
 */
export interface RefreshTokenRecord {
  /** Unique token identifier. */
  readonly jti: string;
  /** Subject (principal) the token was issued to. */
  readonly sub: PrincipalId;
  /** Tenant the token belongs to. */
  readonly tenant_id: TenantId;
  /** Session the token is bound to. */
  readonly session_id: SessionId;
  /** Roles at time of issuance. */
  readonly roles: readonly string[];
  /** Audience the token was issued for. */
  readonly audience: string;
  /** Issued-at timestamp (Unix epoch seconds). */
  readonly iat: number;
  /** Expiration timestamp (Unix epoch seconds). */
  readonly exp: number;
  /** Whether this token has been revoked. */
  readonly revoked: boolean;
}

/**
 * OIDC client for federation with external identity providers.
 */
export interface IOIDCClient {
  /**
   * Validate an external OIDC ID token and extract claims.
   *
   * @param idToken - The external ID token to validate
   * @param tenantId - Tenant context for provider configuration lookup
   * @returns Validated external claims, or null if validation fails
   */
  validateExternalToken(idToken: string, tenantId: TenantId): Promise<OIDCValidationResult | null>;
}

/**
 * Result of validating an external OIDC token.
 */
export interface OIDCValidationResult {
  /** External subject identifier from the IdP. */
  readonly external_sub: string;
  /** Email from the external token (if present). */
  readonly email?: string;
  /** Name from the external token (if present). */
  readonly name?: string;
  /** Issuer of the external token. */
  readonly issuer: string;
  /** Audience of the external token. */
  readonly audience: string;
}

/**
 * Principal resolver — maps external identities to platform principals.
 */
export interface IPrincipalResolver {
  /**
   * Resolve an external identity to a platform principal.
   *
   * @param externalSub - External subject identifier
   * @param tenantId - Tenant context
   * @returns Resolved principal with roles, or null if not found
   */
  resolve(externalSub: string, tenantId: TenantId): Promise<ResolvedPrincipal | null>;

  /**
   * Resolve credentials (username/password) to a platform principal.
   *
   * @param username - The username
   * @param password - The password
   * @param tenantId - Tenant context
   * @returns Resolved principal with roles, or null if credentials are invalid
   */
  resolveCredentials(username: string, password: string, tenantId: TenantId): Promise<ResolvedPrincipal | null>;

  /**
   * Resolve client credentials to a platform principal.
   *
   * @param clientId - The client ID
   * @param clientSecret - The client secret
   * @param tenantId - Tenant context
   * @returns Resolved principal with roles, or null if credentials are invalid
   */
  resolveClientCredentials(clientId: string, clientSecret: string, tenantId: TenantId): Promise<ResolvedPrincipal | null>;
}

/**
 * A resolved platform principal with associated roles.
 */
export interface ResolvedPrincipal {
  /** Platform principal identifier. */
  readonly principal_id: PrincipalId;
  /** Roles assigned to this principal in the tenant. */
  readonly roles: readonly string[];
}

/**
 * Token configuration — lifetimes and signing parameters.
 */
export interface TokenConfig {
  /** Access token lifetime in seconds (max 3600 = 60 minutes). */
  readonly accessTokenLifetimeSeconds: number;
  /** Refresh token lifetime in seconds (max 86400 = 24 hours). */
  readonly refreshTokenLifetimeSeconds: number;
  /** Signing key identifier. */
  readonly signingKeyId: string;
  /** Default audience if not specified in request. */
  readonly defaultAudience: string;
}

/**
 * ID generator for creating unique identifiers.
 */
export interface IIdGenerator {
  /** Generate a new UUID v4 string. */
  uuid(): string;
}

export type { PlatformError };


// ─── Authorization Types ─────────────────────────────────────────────────────

/**
 * Built-in platform roles.
 * These define the base permission sets for the platform.
 */
export type BuiltInRole =
  | 'End_User'
  | 'Tenant_Administrator'
  | 'Platform_Operator'
  | 'Security_Officer'
  | 'Auditor';

/**
 * All built-in role values as a constant array for runtime validation.
 */
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  'End_User',
  'Tenant_Administrator',
  'Platform_Operator',
  'Security_Officer',
  'Auditor',
] as const;

/**
 * Authorization request — input to the Authorize RPC.
 *
 * Contains the principal, tenant, resource, action, and optional
 * context attributes for ABAC evaluation.
 */
export interface AuthzRequest {
  /** The principal requesting access. */
  readonly principal_id: PrincipalId;
  /** The tenant context for the authorization decision. */
  readonly tenant_id: TenantId;
  /** The resource being accessed (e.g., "memory:write", "audit:query"). */
  readonly resource: string;
  /** The action being performed on the resource (e.g., "read", "write", "delete", "execute"). */
  readonly action: string;
  /** Optional context attributes for ABAC evaluation (e.g., time of day, IP, data ownership). */
  readonly context_attributes?: Readonly<Record<string, string>>;
  /** Correlation identifier for distributed tracing. */
  readonly correlation_id: CorrelationId;
}

/**
 * Authorization decision — output of the Authorize RPC.
 *
 * Contains the decision (ALLOW or DENY), the reason, the matched policy
 * (if any), and the audit event ID for traceability.
 */
export interface AuthzDecision {
  /** The authorization decision. */
  readonly decision: 'ALLOW' | 'DENY';
  /** Human-readable reason for the decision. */
  readonly reason: string;
  /** The policy that matched (if decision is ALLOW). */
  readonly matched_policy?: string;
  /** The audit event ID emitted for this decision. */
  readonly audit_event_id: string;
}

/**
 * A permission grant — defines what a role is allowed to do.
 */
export interface PermissionGrant {
  /** The resource pattern this grant applies to (supports wildcards, e.g., "memory:*"). */
  readonly resource: string;
  /** The action(s) this grant allows (supports wildcards, e.g., "*"). */
  readonly action: string;
  /** Optional ABAC conditions that must be satisfied for this grant to apply. */
  readonly conditions?: readonly AttributeCondition[];
}

/**
 * An attribute condition for ABAC evaluation.
 *
 * Conditions are evaluated against the context_attributes in the AuthzRequest.
 * All conditions on a grant must be satisfied for the grant to match.
 */
export interface AttributeCondition {
  /** The attribute key to evaluate (e.g., "time_of_day", "data_owner"). */
  readonly attribute: string;
  /** The operator for comparison. */
  readonly operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'matches';
  /** The value(s) to compare against. */
  readonly value: string | readonly string[];
}

/**
 * A role definition — either built-in or custom.
 */
export interface RoleDefinition {
  /** Unique role name. */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** Whether this is a built-in role. */
  readonly is_builtin: boolean;
  /** The tenant this role belongs to (undefined for built-in roles). */
  readonly tenant_id?: TenantId;
  /** Permission grants associated with this role. */
  readonly permissions: readonly PermissionGrant[];
}

/**
 * A principal's role assignment within a tenant.
 */
export interface RoleAssignment {
  /** The principal who has this role. */
  readonly principal_id: PrincipalId;
  /** The tenant context. */
  readonly tenant_id: TenantId;
  /** The role name assigned. */
  readonly role: string;
}

// ─── Authorization Service Interface ─────────────────────────────────────────

/**
 * Authorization service — evaluates RBAC/ABAC access decisions.
 *
 * Implements the Authorize RPC from the Identity_Service gRPC definition.
 * Enforces default-deny: if no explicit permission grant matches, the
 * decision is DENY.
 *
 * @see Requirement 12.1 - Built-in roles
 * @see Requirement 12.2 - Custom role definitions
 * @see Requirement 12.3 - Role + attribute evaluation
 * @see Requirement 12.4 - Audit event emission
 * @see Requirement 12.5 - Default-deny policy
 */
export interface IAuthorizationService {
  /**
   * Evaluate an authorization request and return a decision.
   *
   * The evaluation process:
   * 1. Resolve the principal's roles in the tenant
   * 2. Collect all permission grants from those roles
   * 3. Match grants against the requested resource + action
   * 4. Evaluate ABAC conditions if present
   * 5. If any grant matches → ALLOW; otherwise → DENY (default-deny)
   * 6. Emit an audit event for the decision
   *
   * @param request - The authorization request
   * @returns The authorization decision with audit trail
   */
  authorize(request: AuthzRequest): Promise<AuthzDecision>;
}

// ─── Policy Store Interface ──────────────────────────────────────────────────

/**
 * Policy store — loads role definitions and principal role assignments.
 *
 * Decouples the authorization engine from the persistence layer.
 * Implementations may be in-memory (for testing), database-backed,
 * or policy-engine-backed (e.g., OPA, Cedar).
 */
export interface IPolicyStore {
  /**
   * Get all role definitions available for a tenant.
   * Includes built-in roles and tenant-specific custom roles.
   *
   * @param tenantId - The tenant context
   * @returns All applicable role definitions
   */
  getRoleDefinitions(tenantId: TenantId): Promise<readonly RoleDefinition[]>;

  /**
   * Get a specific role definition by name.
   *
   * @param roleName - The role name to look up
   * @param tenantId - The tenant context
   * @returns The role definition, or null if not found
   */
  getRoleDefinition(roleName: string, tenantId: TenantId): Promise<RoleDefinition | null>;

  /**
   * Get all role assignments for a principal in a tenant.
   *
   * @param principalId - The principal to look up
   * @param tenantId - The tenant context
   * @returns The principal's role assignments
   */
  getRoleAssignments(principalId: PrincipalId, tenantId: TenantId): Promise<readonly RoleAssignment[]>;

  /**
   * Add a custom role definition for a tenant.
   *
   * @param role - The role definition to add
   */
  addRoleDefinition(role: RoleDefinition): Promise<void>;

  /**
   * Assign a role to a principal in a tenant.
   *
   * @param assignment - The role assignment
   */
  assignRole(assignment: RoleAssignment): Promise<void>;

  /**
   * Remove a role assignment from a principal.
   *
   * @param principalId - The principal
   * @param roleName - The role to remove
   * @param tenantId - The tenant context
   */
  removeRoleAssignment(principalId: PrincipalId, roleName: string, tenantId: TenantId): Promise<void>;
}

// ─── Audit Emitter Interface ─────────────────────────────────────────────────

/**
 * Audit event payload for authorization decisions.
 */
export interface AuthzAuditPayload {
  /** The principal that was evaluated. */
  readonly principal_id: string;
  /** The tenant context. */
  readonly tenant_id: string;
  /** The resource that was requested. */
  readonly resource: string;
  /** The action that was requested. */
  readonly action: string;
  /** The authorization decision. */
  readonly decision: 'ALLOW' | 'DENY';
  /** The reason for the decision. */
  readonly reason: string;
  /** The matched policy (if ALLOW). */
  readonly matched_policy?: string;
  /** The roles evaluated. */
  readonly roles_evaluated: readonly string[];
  /** Context attributes provided in the request. */
  readonly context_attributes?: Readonly<Record<string, string>>;
}

/**
 * Audit emitter for authorization decisions.
 * Decouples the authorization engine from the Audit_Service implementation.
 *
 * @see Requirement 12.4 - Every authorization decision emits an audit event
 */
export interface IAuthzAuditEmitter {
  /**
   * Emit an authorization decision audit event.
   *
   * @param payload - The audit event payload
   * @param correlationId - Correlation ID for distributed tracing
   * @returns The generated audit event ID
   */
  emit(payload: AuthzAuditPayload, correlationId: CorrelationId): Promise<string>;
}


// ─── Confirmation Challenge Interfaces ───────────────────────────────────────

export type {
  IConfirmationChallengeService,
  IChallengeStore,
  ILockoutStore,
  INonceGenerator,
  IChallengeAuditEmitter,
  IssueChallengeRequest,
  ValidateChallengeRequest,
  ChallengeValidationResult,
  ChallengeRejectionReason,
  ChallengeAuditEventType,
  ChallengeAuditPayload,
  ConfirmationChallengeConfig,
} from './confirmation-challenge.js';
