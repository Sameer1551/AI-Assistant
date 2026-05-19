/**
 * Service-to-service authentication using mTLS/SPIFFE.
 *
 * Validates service identity from mutual TLS certificates with SPIFFE IDs.
 * All inter-service traffic MUST be authenticated — unauthenticated calls
 * are rejected.
 *
 * @see Requirement 11.5 - mTLS or signed workload identities, reject unauthenticated traffic
 */

import type {
  IServiceAuthenticator,
  ServiceCertificate,
  ServiceIdentity,
  IAuditEmitter,
  ITrustDomainRegistry,
  ICertificateRevocationChecker,
  IServiceCallPolicy,
} from './interfaces/service-auth.js';
import type { IClock } from './interfaces/index.js';

// ─── SPIFFE ID Parsing ───────────────────────────────────────────────────────

/**
 * Regex for validating SPIFFE ID format: spiffe://trust-domain/service-name
 * Trust domain: one or more segments of alphanumeric/hyphen separated by dots
 * Service name: one or more segments of alphanumeric/hyphen separated by slashes
 */
const SPIFFE_ID_REGEX = /^spiffe:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/;

/**
 * Parse a SPIFFE ID into trust domain and service name components.
 *
 * @param spiffeId - The SPIFFE ID string to parse
 * @returns Parsed components or null if format is invalid
 */
export function parseSpiffeId(spiffeId: string): { trustDomain: string; serviceName: string } | null {
  const match = SPIFFE_ID_REGEX.exec(spiffeId);
  if (!match) {
    return null;
  }
  const trustDomain = match[1]!;
  const serviceName = match[5]!;
  return { trustDomain, serviceName };
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Dependencies required by ServiceAuthenticator (constructor injection).
 */
export interface ServiceAuthenticatorDependencies {
  /** Clock for time-based validation */
  readonly clock: IClock;
  /** Audit event emitter */
  readonly auditEmitter: IAuditEmitter;
  /** Trust domain registry */
  readonly trustDomainRegistry: ITrustDomainRegistry;
  /** Certificate revocation checker */
  readonly revocationChecker: ICertificateRevocationChecker;
  /** Service call authorization policy */
  readonly serviceCallPolicy: IServiceCallPolicy;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Authenticates services via mTLS certificates with SPIFFE identity.
 *
 * Validation pipeline:
 * 1. Parse and validate SPIFFE ID format
 * 2. Check certificate temporal validity (not_before ≤ now ≤ not_after)
 * 3. Verify trust domain is recognized
 * 4. Check certificate revocation status
 *
 * All failures emit audit events for security monitoring.
 */
export class ServiceAuthenticator implements IServiceAuthenticator {
  private readonly clock: IClock;
  private readonly auditEmitter: IAuditEmitter;
  private readonly trustDomainRegistry: ITrustDomainRegistry;
  private readonly revocationChecker: ICertificateRevocationChecker;
  private readonly serviceCallPolicy: IServiceCallPolicy;

  constructor(deps: ServiceAuthenticatorDependencies) {
    this.clock = deps.clock;
    this.auditEmitter = deps.auditEmitter;
    this.trustDomainRegistry = deps.trustDomainRegistry;
    this.revocationChecker = deps.revocationChecker;
    this.serviceCallPolicy = deps.serviceCallPolicy;
  }

  /**
   * Authenticate a service from its presented mTLS certificate.
   *
   * @param cert - The service certificate from the mTLS handshake
   * @returns Authenticated ServiceIdentity on success, null if authentication fails
   */
  async authenticateService(cert: ServiceCertificate): Promise<ServiceIdentity | null> {
    // Step 1: Parse and validate SPIFFE ID format
    const parsed = parseSpiffeId(cert.spiffe_id);
    if (!parsed) {
      await this.emitAuthFailure(cert.spiffe_id, 'INVALID_SPIFFE_ID', cert.fingerprint);
      return null;
    }

    // Step 2: Check certificate temporal validity
    const nowISO = this.clock.nowISO();
    if (nowISO < cert.not_before || nowISO > cert.not_after) {
      await this.emitAuthFailure(cert.spiffe_id, 'CERTIFICATE_EXPIRED', cert.fingerprint);
      return null;
    }

    // Step 3: Verify trust domain is recognized
    const trusted = await this.trustDomainRegistry.isTrusted(parsed.trustDomain);
    if (!trusted) {
      await this.emitAuthFailure(cert.spiffe_id, 'UNTRUSTED_DOMAIN', cert.fingerprint);
      return null;
    }

    // Step 4: Check certificate revocation status
    const revoked = await this.revocationChecker.isRevoked(cert.fingerprint);
    if (revoked) {
      await this.emitAuthFailure(cert.spiffe_id, 'CERTIFICATE_REVOKED', cert.fingerprint);
      return null;
    }

    // Authentication successful
    const identity: ServiceIdentity = {
      service_name: parsed.serviceName,
      spiffe_id: cert.spiffe_id,
      trust_domain: parsed.trustDomain,
      authenticated_at: nowISO,
    };

    await this.auditEmitter.emit({
      event_category: 'service_auth.success',
      severity: 'INFO',
      principal_id: cert.spiffe_id,
      source_service: 'identity-service',
      outcome: 'SUCCESS',
      payload: {
        service_name: parsed.serviceName,
        trust_domain: parsed.trustDomain,
        fingerprint: cert.fingerprint,
      },
    });

    return identity;
  }

  /**
   * Validate whether an authenticated service is allowed to call a target service.
   *
   * @param identity - The authenticated service identity
   * @param targetService - The service being called
   * @returns True if the call is authorized, false otherwise
   */
  async validateServiceCall(identity: ServiceIdentity, targetService: string): Promise<boolean> {
    const allowed = await this.serviceCallPolicy.isAllowed(identity.service_name, targetService);

    if (!allowed) {
      await this.auditEmitter.emit({
        event_category: 'service_auth.call_denied',
        severity: 'HIGH',
        principal_id: identity.spiffe_id,
        source_service: 'identity-service',
        outcome: 'DENIED',
        payload: {
          source_service: identity.service_name,
          target_service: targetService,
          trust_domain: identity.trust_domain,
        },
      });
    }

    return allowed;
  }

  /**
   * Emit an authentication failure audit event.
   */
  private async emitAuthFailure(spiffeId: string, reason: string, fingerprint: string): Promise<void> {
    await this.auditEmitter.emit({
      event_category: 'service_auth.failure',
      severity: 'HIGH',
      principal_id: spiffeId,
      source_service: 'identity-service',
      outcome: 'DENIED',
      payload: {
        reason,
        fingerprint,
        spiffe_id: spiffeId,
      },
    });
  }
}
