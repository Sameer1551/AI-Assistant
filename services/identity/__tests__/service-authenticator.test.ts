/**
 * Unit tests for ServiceAuthenticator — mTLS/SPIFFE service-to-service authentication.
 *
 * @see Requirement 11.5 - mTLS or signed workload identities, reject unauthenticated traffic
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceAuthenticator, parseSpiffeId } from '../src/service-authenticator.js';
import type {
  ServiceCertificate,
  IAuditEmitter,
  ITrustDomainRegistry,
  ICertificateRevocationChecker,
  IServiceCallPolicy,
} from '../src/interfaces/service-auth.js';
import type { IClock } from '../src/interfaces/index.js';
import type { ISOTimestamp } from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentSeconds = 1700000000; // 2023-11-14T22:13:20Z

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

class MockAuditEmitter implements IAuditEmitter {
  readonly events: Array<{
    event_category: string;
    severity: string;
    principal_id: string;
    source_service: string;
    outcome: string;
    payload: Record<string, unknown>;
  }> = [];

  async emit(event: {
    event_category: string;
    severity: string;
    principal_id: string;
    source_service: string;
    outcome: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.events.push({ ...event, payload: { ...event.payload } });
  }
}

class MockTrustDomainRegistry implements ITrustDomainRegistry {
  private readonly trusted: Set<string> = new Set(['example.org', 'may-platform.io']);

  addTrusted(domain: string): void {
    this.trusted.add(domain);
  }

  async isTrusted(domain: string): Promise<boolean> {
    return this.trusted.has(domain);
  }
}

class MockRevocationChecker implements ICertificateRevocationChecker {
  private readonly revoked: Set<string> = new Set();

  revoke(fingerprint: string): void {
    this.revoked.add(fingerprint);
  }

  async isRevoked(fingerprint: string): Promise<boolean> {
    return this.revoked.has(fingerprint);
  }
}

class MockServiceCallPolicy implements IServiceCallPolicy {
  private readonly allowed: Set<string> = new Set([
    'llm-gateway->audit-service',
    'control-service->audit-service',
    'workflow-service->control-service',
  ]);

  allow(source: string, target: string): void {
    this.allowed.add(`${source}->${target}`);
  }

  async isAllowed(sourceService: string, targetService: string): Promise<boolean> {
    return this.allowed.has(`${sourceService}->${targetService}`);
  }
}

function makeValidCert(overrides?: Partial<ServiceCertificate>): ServiceCertificate {
  return {
    spiffe_id: 'spiffe://example.org/llm-gateway',
    subject: 'CN=llm-gateway,O=May Platform',
    issuer: 'CN=May CA,O=May Platform',
    not_before: '2023-01-01T00:00:00.000Z' as ISOTimestamp,
    not_after: '2025-01-01T00:00:00.000Z' as ISOTimestamp,
    fingerprint: 'sha256:abc123def456',
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('parseSpiffeId', () => {
  it('should parse a valid SPIFFE ID', () => {
    const result = parseSpiffeId('spiffe://example.org/llm-gateway');
    expect(result).toEqual({
      trustDomain: 'example.org',
      serviceName: 'llm-gateway',
    });
  });

  it('should parse SPIFFE ID with multi-segment trust domain', () => {
    const result = parseSpiffeId('spiffe://prod.may-platform.io/audit-service');
    expect(result).toEqual({
      trustDomain: 'prod.may-platform.io',
      serviceName: 'audit-service',
    });
  });

  it('should parse SPIFFE ID with path segments in service name', () => {
    const result = parseSpiffeId('spiffe://example.org/services/llm-gateway');
    expect(result).toEqual({
      trustDomain: 'example.org',
      serviceName: 'services/llm-gateway',
    });
  });

  it('should return null for invalid SPIFFE ID (missing prefix)', () => {
    expect(parseSpiffeId('http://example.org/service')).toBeNull();
  });

  it('should return null for invalid SPIFFE ID (empty service name)', () => {
    expect(parseSpiffeId('spiffe://example.org/')).toBeNull();
  });

  it('should return null for invalid SPIFFE ID (uppercase)', () => {
    expect(parseSpiffeId('spiffe://Example.Org/Service')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseSpiffeId('')).toBeNull();
  });
});

describe('ServiceAuthenticator', () => {
  let authenticator: ServiceAuthenticator;
  let clock: MockClock;
  let auditEmitter: MockAuditEmitter;
  let trustDomainRegistry: MockTrustDomainRegistry;
  let revocationChecker: MockRevocationChecker;
  let serviceCallPolicy: MockServiceCallPolicy;

  beforeEach(() => {
    clock = new MockClock();
    auditEmitter = new MockAuditEmitter();
    trustDomainRegistry = new MockTrustDomainRegistry();
    revocationChecker = new MockRevocationChecker();
    serviceCallPolicy = new MockServiceCallPolicy();

    authenticator = new ServiceAuthenticator({
      clock,
      auditEmitter,
      trustDomainRegistry,
      revocationChecker,
      serviceCallPolicy,
    });
  });

  describe('authenticateService', () => {
    it('should authenticate a valid service certificate', async () => {
      const cert = makeValidCert();
      const identity = await authenticator.authenticateService(cert);

      expect(identity).not.toBeNull();
      expect(identity!.service_name).toBe('llm-gateway');
      expect(identity!.spiffe_id).toBe('spiffe://example.org/llm-gateway');
      expect(identity!.trust_domain).toBe('example.org');
      expect(identity!.authenticated_at).toBeDefined();
    });

    it('should emit success audit event on valid authentication', async () => {
      const cert = makeValidCert();
      await authenticator.authenticateService(cert);

      expect(auditEmitter.events).toHaveLength(1);
      expect(auditEmitter.events[0]!.event_category).toBe('service_auth.success');
      expect(auditEmitter.events[0]!.severity).toBe('INFO');
      expect(auditEmitter.events[0]!.outcome).toBe('SUCCESS');
    });

    it('should reject certificate with invalid SPIFFE ID format', async () => {
      const cert = makeValidCert({ spiffe_id: 'invalid://not-spiffe' });
      const identity = await authenticator.authenticateService(cert);

      expect(identity).toBeNull();
      expect(auditEmitter.events).toHaveLength(1);
      expect(auditEmitter.events[0]!.event_category).toBe('service_auth.failure');
      expect(auditEmitter.events[0]!.payload['reason']).toBe('INVALID_SPIFFE_ID');
    });

    it('should reject expired certificate (past not_after)', async () => {
      const cert = makeValidCert({
        not_before: '2020-01-01T00:00:00.000Z' as ISOTimestamp,
        not_after: '2022-01-01T00:00:00.000Z' as ISOTimestamp,
      });
      const identity = await authenticator.authenticateService(cert);

      expect(identity).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('CERTIFICATE_EXPIRED');
    });

    it('should reject certificate not yet valid (before not_before)', async () => {
      const cert = makeValidCert({
        not_before: '2024-01-01T00:00:00.000Z' as ISOTimestamp,
        not_after: '2025-01-01T00:00:00.000Z' as ISOTimestamp,
      });
      const identity = await authenticator.authenticateService(cert);

      expect(identity).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('CERTIFICATE_EXPIRED');
    });

    it('should reject certificate from untrusted domain', async () => {
      const cert = makeValidCert({
        spiffe_id: 'spiffe://untrusted.evil.com/malicious-service',
      });
      const identity = await authenticator.authenticateService(cert);

      expect(identity).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('UNTRUSTED_DOMAIN');
    });

    it('should reject revoked certificate', async () => {
      const cert = makeValidCert({ fingerprint: 'sha256:revoked-cert' });
      revocationChecker.revoke('sha256:revoked-cert');

      const identity = await authenticator.authenticateService(cert);

      expect(identity).toBeNull();
      expect(auditEmitter.events[0]!.payload['reason']).toBe('CERTIFICATE_REVOKED');
    });

    it('should reject unauthenticated traffic (no valid cert)', async () => {
      // Simulate unauthenticated traffic with empty/invalid cert
      const cert = makeValidCert({ spiffe_id: '' });
      const identity = await authenticator.authenticateService(cert);

      expect(identity).toBeNull();
    });

    it('should emit HIGH severity audit event on authentication failure', async () => {
      const cert = makeValidCert({ spiffe_id: 'invalid' });
      await authenticator.authenticateService(cert);

      expect(auditEmitter.events[0]!.severity).toBe('HIGH');
      expect(auditEmitter.events[0]!.outcome).toBe('DENIED');
    });
  });

  describe('validateServiceCall', () => {
    it('should allow authorized service-to-service calls', async () => {
      const cert = makeValidCert();
      const identity = await authenticator.authenticateService(cert);
      expect(identity).not.toBeNull();

      // llm-gateway -> audit-service is allowed in our mock policy
      const allowed = await authenticator.validateServiceCall(identity!, 'audit-service');
      expect(allowed).toBe(true);
    });

    it('should deny unauthorized service-to-service calls', async () => {
      const cert = makeValidCert();
      const identity = await authenticator.authenticateService(cert);
      expect(identity).not.toBeNull();

      // llm-gateway -> secrets-service is NOT in our mock policy
      const allowed = await authenticator.validateServiceCall(identity!, 'secrets-service');
      expect(allowed).toBe(false);
    });

    it('should emit HIGH severity audit event on denied call', async () => {
      const cert = makeValidCert();
      const identity = await authenticator.authenticateService(cert);
      auditEmitter.events.length = 0; // Clear auth success event

      await authenticator.validateServiceCall(identity!, 'secrets-service');

      expect(auditEmitter.events).toHaveLength(1);
      expect(auditEmitter.events[0]!.event_category).toBe('service_auth.call_denied');
      expect(auditEmitter.events[0]!.severity).toBe('HIGH');
      expect(auditEmitter.events[0]!.outcome).toBe('DENIED');
      expect(auditEmitter.events[0]!.payload['source_service']).toBe('llm-gateway');
      expect(auditEmitter.events[0]!.payload['target_service']).toBe('secrets-service');
    });

    it('should not emit audit event on allowed call', async () => {
      const cert = makeValidCert();
      const identity = await authenticator.authenticateService(cert);
      auditEmitter.events.length = 0;

      await authenticator.validateServiceCall(identity!, 'audit-service');

      expect(auditEmitter.events).toHaveLength(0);
    });
  });
});
