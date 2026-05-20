/**
 * Property-Based Tests for Tenant Isolation
 *
 * Property 8: Per-Tenant Cryptographic Isolation
 *
 * @see Requirements 25.4, 25.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TenantIsolationService } from '../src/tenant-isolation.js';

describe('Tenant_Isolation_Service PBT', () => {
  it('Property 8: Per-Tenant Cryptographic Isolation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3 }), // Tenant A ID
        fc.string({ minLength: 3 }), // Tenant B ID
        fc.string({ minLength: 1 }), // Plaintext
        async (tenantA, tenantB, plaintext) => {
          // Avoid collision in randomly generated IDs
          fc.pre(tenantA !== tenantB);

          const auditEvents: any[] = [];
          const service = new TenantIsolationService({
            auditPublisher: {
              publishAudit: async (e) => {
                auditEvents.push(e);
              },
            },
          });

          // Simulate per-tenant encryption keys
          const keys: Record<string, string> = {
            [tenantA]: `key-for-${tenantA}`,
            [tenantB]: `key-for-${tenantB}`,
          };

          // 1. Tenant A encrypts and can decrypt their own data successfully
          const ciphertextA = service.encryptForTenant(tenantA, plaintext, keys);
          const decryptedA = await service.decryptForTenant(tenantA, ciphertextA, keys);
          expect(decryptedA).toBe(plaintext);
          expect(auditEvents.length).toBe(0);

          // 2. Tenant B attempts to decrypt Tenant A's ciphertext -> MUST fail and trigger audit
          await expect(service.decryptForTenant(tenantB, ciphertextA, keys)).rejects.toThrow(
            /Cryptographic Isolation Error/
          );

          expect(auditEvents.length).toBe(1);
          expect(auditEvents[0].severity).toBe('high');
          expect(auditEvents[0].metadata.attempted_tenant_id).toBe(tenantB);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Enforces boundaries on cross-tenant operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3 }),
        fc.string({ minLength: 3 }),
        async (requestTenant, recordTenant) => {
          const auditEvents: any[] = [];
          const service = new TenantIsolationService({
            auditPublisher: {
              publishAudit: async (e) => {
                auditEvents.push(e);
              },
            },
          });

          if (requestTenant !== recordTenant) {
            await expect(
              service.enforceIsolationConstraint(requestTenant, recordTenant, 'user-1')
            ).rejects.toThrow(/isolation violation/);

            expect(auditEvents.length).toBe(1);
            expect(auditEvents[0].severity).toBe('high');
          } else {
            await expect(
              service.enforceIsolationConstraint(requestTenant, recordTenant, 'user-1')
            ).resolves.toBeUndefined();
            expect(auditEvents.length).toBe(0);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
