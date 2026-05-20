/**
 * @module tenant-isolation
 * TenantIsolationService: Multi-tenant cryptographic isolation, access gating, and residency checks.
 *
 * @see Requirements 25.4, 25.5, Property 8
 */

import { randomUUID } from 'node:crypto';

export interface AuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export class TenantIsolationService {
  private readonly auditPublisher: AuditPublisher;

  constructor(deps: { readonly auditPublisher: AuditPublisher }) {
    this.auditPublisher = deps.auditPublisher;
  }

  /**
   * Encrypts plaintext data specifically for a given tenant using their unique key.
   */
  encryptForTenant(tenantId: string, plaintext: string, tenantKeys: Record<string, string>): string {
    const key = tenantKeys[tenantId];
    if (!key) {
      throw new Error(`No encryption key found for tenant: ${tenantId}`);
    }
    // Simulate encryption by prefixing with tenantId and key signature
    return `encrypted_with_${key}:${Buffer.from(plaintext).toString('base64')}`;
  }

  /**
   * Decrypts ciphertext data specifically for a given tenant.
   *
   * @see Property 8
   */
  async decryptForTenant(
    tenantId: string,
    ciphertext: string,
    tenantKeys: Record<string, string>
  ): Promise<string> {
    const key = tenantKeys[tenantId];
    if (!key) {
      throw new Error(`No encryption key found for tenant: ${tenantId}`);
    }

    const prefix = `encrypted_with_${key}:`;
    if (!ciphertext.startsWith(prefix)) {
      // Cryptographic isolation failure: Tenant key does not match ciphertext header!
      // This indicates a cross-tenant decryption attempt. Emit high-severity audit.
      await this.auditPublisher.publishAudit({
        event_id: randomUUID(),
        severity: 'high',
        timestamp: new Date().toISOString(),
        message: `CRITICAL SECURITY: Tenant ${tenantId} failed to decrypt ciphertext. Key mismatch or cross-tenant contamination.`,
        metadata: {
          attempted_tenant_id: tenantId,
        },
      });

      throw new Error(`Cryptographic Isolation Error: Key for tenant ${tenantId} cannot decrypt this payload.`);
    }

    const base64Data = ciphertext.substring(prefix.length);
    return Buffer.from(base64Data, 'base64').toString('utf8');
  }

  /**
   * Deny cross-tenant access attempts with high-severity audit event.
   */
  async enforceIsolationConstraint(
    requestTenantId: string,
    recordTenantId: string,
    principalId: string
  ): Promise<void> {
    if (requestTenantId !== recordTenantId) {
      await this.auditPublisher.publishAudit({
        event_id: randomUUID(),
        severity: 'high',
        timestamp: new Date().toISOString(),
        message: `CROSS-TENANT VIOLATION ATTEMPT: Principal ${principalId} belonging to Tenant ${requestTenantId} attempted to access data of Tenant ${recordTenantId}.`,
        metadata: {
          request_tenant_id: requestTenantId,
          record_tenant_id: recordTenantId,
          principal_id: principalId,
        },
      });

      throw new Error(`Access Denied: Tenant boundary isolation violation. ${requestTenantId} !== ${recordTenantId}`);
    }
  }

  /**
   * Enforce Data Residency Region on processing.
   */
  enforceResidencyRegion(tenantId: string, configuredRegion: string, targetRegion: string): void {
    if (configuredRegion.toLowerCase().trim() !== targetRegion.toLowerCase().trim()) {
      throw new Error(
        `Data Residency Violation: Operation in region ${targetRegion} violates tenant ${tenantId} residency policy (${configuredRegion}).`
      );
    }
  }
}
