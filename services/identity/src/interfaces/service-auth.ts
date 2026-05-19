/**
 * Service-to-service authentication interfaces.
 *
 * Defines contracts for mTLS/SPIFFE-based service identity validation
 * and break-glass emergency access management.
 *
 * @see Requirement 11.5 - mTLS or signed workload identities, reject unauthenticated traffic
 * @see Requirement 11.6 - MFA for roles requiring it
 * @see Requirement 12.6 - Break-glass with dual approval, 4h limit, audit events
 */

import type { TenantId, PrincipalId, ISOTimestamp } from '@may/types';

// ─── Service Certificate (mTLS/SPIFFE) ───────────────────────────────────────

/**
 * Represents a service certificate presented during mTLS handshake.
 * Contains SPIFFE identity and X.509 certificate metadata.
 */
export interface ServiceCertificate {
  /** SPIFFE ID in format: spiffe://trust-domain/service-name */
  readonly spiffe_id: string;
  /** X.509 subject distinguished name */
  readonly subject: string;
  /** X.509 issuer distinguished name */
  readonly issuer: string;
  /** Certificate validity start (ISO 8601) */
  readonly not_before: ISOTimestamp;
  /** Certificate validity end (ISO 8601) */
  readonly not_after: ISOTimestamp;
  /** SHA-256 fingerprint of the certificate */
  readonly fingerprint: string;
}

/**
 * Authenticated service identity extracted from a validated certificate.
 */
export interface ServiceIdentity {
  /** Canonical service name (e.g., "llm-gateway", "audit-service") */
  readonly service_name: string;
  /** Full SPIFFE ID: spiffe://trust-domain/service-name */
  readonly spiffe_id: string;
  /** Optional tenant context for tenant-scoped services */
  readonly tenant_id?: TenantId;
  /** Trust domain the service belongs to */
  readonly trust_domain: string;
  /** Timestamp when authentication was performed */
  readonly authenticated_at: ISOTimestamp;
}

// ─── Break-Glass Access ──────────────────────────────────────────────────────

/**
 * Request for emergency break-glass access.
 * Requires dual approval (2 approvers) per Requirement 12.6.
 */
export interface BreakGlassRequest {
  /** Principal requesting emergency access */
  readonly requester_id: PrincipalId;
  /** Must contain exactly 2 approver principal IDs (dual approval) */
  readonly approver_ids: readonly [PrincipalId, PrincipalId];
  /** Human-readable justification for the emergency access */
  readonly reason: string;
  /** Target service the access is needed for */
  readonly target_service: string;
  /** Specific action being requested */
  readonly target_action: string;
}

/**
 * A granted break-glass access token.
 * Time-limited to a maximum of 4 hours per Requirement 12.6.
 */
export interface BreakGlassGrant {
  /** Unique identifier for this grant */
  readonly grant_id: string;
  /** Principal who requested the access */
  readonly requester_id: PrincipalId;
  /** The two approvers who authorized this grant */
  readonly approvers: readonly [PrincipalId, PrincipalId];
  /** When the grant was issued (ISO 8601) */
  readonly granted_at: ISOTimestamp;
  /** When the grant expires (max 4h from granted_at) */
  readonly expires_at: ISOTimestamp;
  /** Target service the grant applies to */
  readonly target_service: string;
  /** Specific action the grant authorizes */
  readonly target_action: string;
  /** Whether this grant has been revoked before expiry */
  readonly revoked: boolean;
}

// ─── Approval Record ─────────────────────────────────────────────────────────

/**
 * Records an individual approver's decision on a break-glass request.
 */
export interface BreakGlassApproval {
  /** The approver's principal ID */
  readonly approver_id: PrincipalId;
  /** Whether the approver approved or denied */
  readonly decision: 'approved' | 'denied';
  /** When the decision was made */
  readonly decided_at: ISOTimestamp;
}

// ─── Service Interfaces ──────────────────────────────────────────────────────

/**
 * Validates service identity from mTLS certificates using SPIFFE IDs.
 *
 * All inter-service traffic MUST be authenticated. Unauthenticated
 * service-to-service calls are rejected.
 *
 * @see Requirement 11.5
 */
export interface IServiceAuthenticator {
  /**
   * Authenticate a service from its presented mTLS certificate.
   *
   * Validates:
   * - Certificate is not expired
   * - SPIFFE ID format is valid (spiffe://trust-domain/service-name)
   * - Trust domain is recognized
   * - Certificate fingerprint is not revoked
   *
   * @param cert - The service certificate from the mTLS handshake
   * @returns Authenticated ServiceIdentity on success, null if authentication fails
   */
  authenticateService(cert: ServiceCertificate): Promise<ServiceIdentity | null>;

  /**
   * Validate whether an authenticated service is allowed to call a target service.
   *
   * Enforces service-to-service authorization policies.
   *
   * @param identity - The authenticated service identity
   * @param targetService - The service being called
   * @returns True if the call is authorized, false otherwise
   */
  validateServiceCall(identity: ServiceIdentity, targetService: string): Promise<boolean>;
}

/**
 * Manages emergency break-glass access with dual approval and time limits.
 *
 * Break-glass access:
 * - Requires dual approval (2 approvers)
 * - Time-limited to maximum 4 hours
 * - Emits high-severity audit events at activation and expiration
 *
 * @see Requirement 12.6
 */
export interface IBreakGlassManager {
  /**
   * Request break-glass emergency access.
   *
   * Validates:
   * - Exactly 2 approvers are specified
   * - Requester is not one of the approvers
   * - Target service and action are valid
   *
   * @param request - The break-glass access request
   * @returns The granted access on success, null if validation fails
   */
  requestBreakGlass(request: BreakGlassRequest): Promise<BreakGlassGrant | null>;

  /**
   * Validate whether a break-glass grant is currently active and valid.
   *
   * Checks:
   * - Grant exists
   * - Grant has not expired (4h max)
   * - Grant has not been revoked
   *
   * @param grantId - The grant identifier to validate
   * @returns True if the grant is active and valid
   */
  validateBreakGlass(grantId: string): Promise<boolean>;

  /**
   * Revoke a break-glass grant before its natural expiration.
   * Emits a high-severity audit event on revocation.
   *
   * @param grantId - The grant identifier to revoke
   */
  revokeBreakGlass(grantId: string): Promise<void>;
}

// ─── Dependency Interfaces ───────────────────────────────────────────────────

/**
 * Audit event emitter for service authentication events.
 */
export interface IAuditEmitter {
  /**
   * Emit an audit event.
   *
   * @param event - The audit event to emit
   */
  emit(event: {
    readonly event_category: string;
    readonly severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    readonly principal_id: string;
    readonly source_service: string;
    readonly outcome: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

/**
 * Trust domain registry for validating SPIFFE trust domains.
 */
export interface ITrustDomainRegistry {
  /**
   * Check if a trust domain is recognized and trusted.
   *
   * @param domain - The trust domain to check
   * @returns True if the domain is trusted
   */
  isTrusted(domain: string): Promise<boolean>;
}

/**
 * Certificate revocation checker.
 */
export interface ICertificateRevocationChecker {
  /**
   * Check if a certificate has been revoked.
   *
   * @param fingerprint - SHA-256 fingerprint of the certificate
   * @returns True if the certificate is revoked
   */
  isRevoked(fingerprint: string): Promise<boolean>;
}

/**
 * Service call policy — defines which services can call which.
 */
export interface IServiceCallPolicy {
  /**
   * Check if a source service is allowed to call a target service.
   *
   * @param sourceService - The calling service name
   * @param targetService - The target service name
   * @returns True if the call is permitted
   */
  isAllowed(sourceService: string, targetService: string): Promise<boolean>;
}
