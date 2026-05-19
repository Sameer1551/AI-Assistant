/**
 * Property-based tests for DSAR erasure propagation.
 *
 * **Validates: Requirements 27.3, 27.4**
 *
 * Property 45: DSAR Erasure Propagation — erasure orders issued to all owning
 *   services, tracked per service, legal hold exclusions respected
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import type { RequestContext } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { DSARService } from '../../src/dsar-service.js';
import { InMemoryDSARStore } from '../../src/in-memory-dsar-store.js';
import type {
  IDataOwningService,
  ILegalHoldChecker,
  IDSARClock,
  IDSARIdGenerator,
  LegalHoldExclusion,
} from '../../src/interfaces/index.js';

// ─── Stub Implementations ────────────────────────────────────────────────────

class StubClock implements IDSARClock {
  now(): string {
    return '2024-06-15T10:00:00.000Z';
  }
}

class StubIdGenerator implements IDSARIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `dsar-pbt-${this.counter.toString().padStart(6, '0')}`;
  }
}

/**
 * A configurable data owning service stub.
 * Can be set to succeed or fail erasure execution.
 */
class ConfigurableDataOwningService implements IDataOwningService {
  readonly serviceName: string;
  private readonly succeeds: boolean;
  erasureCalled = false;

  constructor(name: string, succeeds: boolean) {
    this.serviceName = name;
    this.succeeds = succeeds;
  }

  async executeErasure(_dataSubjectId: string, _tenantId: string): Promise<boolean> {
    this.erasureCalled = true;
    return this.succeeds;
  }

  async exportData(_dataSubjectId: string, _tenantId: string): Promise<Record<string, unknown>> {
    return {};
  }
}

/**
 * A configurable legal hold checker that returns holds for specified services.
 */
class ConfigurableLegalHoldChecker implements ILegalHoldChecker {
  private readonly holds: Map<string, LegalHoldExclusion>;

  constructor(holds: Map<string, LegalHoldExclusion>) {
    this.holds = holds;
  }

  async checkHold(
    serviceName: string,
    _dataSubjectId: string,
    _tenantId: string,
  ): Promise<LegalHoldExclusion | null> {
    return this.holds.get(serviceName) ?? null;
  }
}

function createTestContext(tenantId = 'tenant-pbt'): RequestContext {
  return {
    tenant_id: tenantId as TenantId,
    principal_id: 'principal-pbt' as PrincipalId,
    correlation_id: 'corr-pbt-001' as CorrelationId,
    trace_context: { traceparent: '00-trace-pbt-span-01' },
    session_id: 'session-pbt' as SessionId,
    roles: ['Tenant_Administrator'],
    attributes: {},
    residency_region: 'eu-west-1',
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for a unique service name. */
const serviceNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')),
  { minLength: 3, maxLength: 20 },
).filter((s) => s.trim().length >= 3);

/**
 * Arbitrary for a service configuration:
 * - name: unique service name
 * - succeeds: whether erasure will succeed
 * - hasLegalHold: whether the service is under legal hold
 */
const serviceConfigArb = fc.record({
  name: serviceNameArb,
  succeeds: fc.boolean(),
  hasLegalHold: fc.boolean(),
  legalBasis: fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789-#'.split('')),
    { minLength: 5, maxLength: 50 },
  ),
});

/**
 * Arbitrary for a set of service configurations (1 to 10 services).
 * Ensures unique service names.
 */
const serviceSetArb = fc
  .array(serviceConfigArb, { minLength: 1, maxLength: 10 })
  .map((configs) => {
    // Deduplicate by name
    const seen = new Set<string>();
    return configs.filter((c) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
  })
  .filter((configs) => configs.length >= 1);

// ─── Property 45: DSAR Erasure Propagation ───────────────────────────────────

describe('Property 45: DSAR Erasure Propagation', () => {
  const clock = new StubClock();
  const ctx = createTestContext();

  /**
   * **Validates: Requirements 27.3**
   *
   * For ANY set of owning services, every service that is NOT under legal hold
   * MUST receive an erasure order (executeErasure is called).
   */
  it('every owning service without a legal hold receives an erasure order', async () => {
    await fc.assert(
      fc.asyncProperty(serviceSetArb, async (serviceConfigs) => {
        const store = new InMemoryDSARStore();
        const idGenerator = new StubIdGenerator();

        // Build services and legal hold checker
        const services: ConfigurableDataOwningService[] = serviceConfigs.map(
          (cfg) => new ConfigurableDataOwningService(cfg.name, cfg.succeeds),
        );

        const holds = new Map<string, LegalHoldExclusion>();
        for (const cfg of serviceConfigs) {
          if (cfg.hasLegalHold) {
            holds.set(cfg.name, {
              service_name: cfg.name,
              legal_basis: cfg.legalBasis,
              hold_applied_at: '2024-01-01T00:00:00.000Z',
            });
          }
        }

        const legalHoldChecker = new ConfigurableLegalHoldChecker(holds);
        const dsarService = new DSARService(
          store,
          services,
          legalHoldChecker,
          clock,
          idGenerator,
        );

        // Submit and process erasure
        const ack = await dsarService.submitRequest(
          { data_subject_id: 'subject-pbt', request_type: 'erasure' },
          ctx,
        );
        await dsarService.processErasure(ack.dsar_id, ctx);

        // Verify: every non-held service had erasure called
        for (const svc of services) {
          const isHeld = holds.has(svc.serviceName);
          if (!isHeld) {
            expect(svc.erasureCalled).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 27.4**
   *
   * For ANY set of owning services with legal holds, services under legal hold
   * are excluded from erasure and documented in legal_hold_exclusions with
   * their service name and legal basis.
   */
  it('services under legal hold are excluded and documented in legal_hold_exclusions', async () => {
    await fc.assert(
      fc.asyncProperty(serviceSetArb, async (serviceConfigs) => {
        const store = new InMemoryDSARStore();
        const idGenerator = new StubIdGenerator();

        const services: ConfigurableDataOwningService[] = serviceConfigs.map(
          (cfg) => new ConfigurableDataOwningService(cfg.name, cfg.succeeds),
        );

        const holds = new Map<string, LegalHoldExclusion>();
        for (const cfg of serviceConfigs) {
          if (cfg.hasLegalHold) {
            holds.set(cfg.name, {
              service_name: cfg.name,
              legal_basis: cfg.legalBasis,
              hold_applied_at: '2024-01-01T00:00:00.000Z',
            });
          }
        }

        const legalHoldChecker = new ConfigurableLegalHoldChecker(holds);
        const dsarService = new DSARService(
          store,
          services,
          legalHoldChecker,
          clock,
          idGenerator,
        );

        const ack = await dsarService.submitRequest(
          { data_subject_id: 'subject-pbt', request_type: 'erasure' },
          ctx,
        );
        const result = await dsarService.processErasure(ack.dsar_id, ctx);

        // Verify: legal_hold_exclusions contains exactly the held services
        const heldServiceNames = serviceConfigs
          .filter((cfg) => cfg.hasLegalHold)
          .map((cfg) => cfg.name);

        expect(result.legal_hold_exclusions.length).toBe(heldServiceNames.length);

        for (const exclusion of result.legal_hold_exclusions) {
          expect(heldServiceNames).toContain(exclusion.service_name);
          // Legal basis must be documented (non-empty)
          expect(exclusion.legal_basis.length).toBeGreaterThan(0);
          // Must match the configured basis
          const expectedHold = holds.get(exclusion.service_name);
          expect(exclusion.legal_basis).toBe(expectedHold!.legal_basis);
        }

        // Verify: held services did NOT have erasure called
        for (const svc of services) {
          if (holds.has(svc.serviceName)) {
            expect(svc.erasureCalled).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 27.3**
   *
   * For ANY set of owning services, service_completion tracks every service's
   * status (true for successful erasure, false for failed or held).
   */
  it('service_completion tracks every service status', async () => {
    await fc.assert(
      fc.asyncProperty(serviceSetArb, async (serviceConfigs) => {
        const store = new InMemoryDSARStore();
        const idGenerator = new StubIdGenerator();

        const services: ConfigurableDataOwningService[] = serviceConfigs.map(
          (cfg) => new ConfigurableDataOwningService(cfg.name, cfg.succeeds),
        );

        const holds = new Map<string, LegalHoldExclusion>();
        for (const cfg of serviceConfigs) {
          if (cfg.hasLegalHold) {
            holds.set(cfg.name, {
              service_name: cfg.name,
              legal_basis: cfg.legalBasis,
              hold_applied_at: '2024-01-01T00:00:00.000Z',
            });
          }
        }

        const legalHoldChecker = new ConfigurableLegalHoldChecker(holds);
        const dsarService = new DSARService(
          store,
          services,
          legalHoldChecker,
          clock,
          idGenerator,
        );

        const ack = await dsarService.submitRequest(
          { data_subject_id: 'subject-pbt', request_type: 'erasure' },
          ctx,
        );
        const result = await dsarService.processErasure(ack.dsar_id, ctx);

        // Verify: service_completion has an entry for every service
        for (const cfg of serviceConfigs) {
          expect(cfg.name in result.service_completion).toBe(true);

          if (holds.has(cfg.name)) {
            // Held services are marked as false (not completed)
            expect(result.service_completion[cfg.name]).toBe(false);
          } else {
            // Non-held services reflect their actual erasure result
            expect(result.service_completion[cfg.name]).toBe(cfg.succeeds);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 27.3, 27.4**
   *
   * For ANY set of owning services, fully_completed is true ONLY when
   * all non-held services succeed their erasure AND there are no legal holds.
   */
  it('fully_completed is true only when all non-held services succeed and no holds exist', async () => {
    await fc.assert(
      fc.asyncProperty(serviceSetArb, async (serviceConfigs) => {
        const store = new InMemoryDSARStore();
        const idGenerator = new StubIdGenerator();

        const services: ConfigurableDataOwningService[] = serviceConfigs.map(
          (cfg) => new ConfigurableDataOwningService(cfg.name, cfg.succeeds),
        );

        const holds = new Map<string, LegalHoldExclusion>();
        for (const cfg of serviceConfigs) {
          if (cfg.hasLegalHold) {
            holds.set(cfg.name, {
              service_name: cfg.name,
              legal_basis: cfg.legalBasis,
              hold_applied_at: '2024-01-01T00:00:00.000Z',
            });
          }
        }

        const legalHoldChecker = new ConfigurableLegalHoldChecker(holds);
        const dsarService = new DSARService(
          store,
          services,
          legalHoldChecker,
          clock,
          idGenerator,
        );

        const ack = await dsarService.submitRequest(
          { data_subject_id: 'subject-pbt', request_type: 'erasure' },
          ctx,
        );
        const result = await dsarService.processErasure(ack.dsar_id, ctx);

        // Compute expected fully_completed
        const hasAnyHold = serviceConfigs.some((cfg) => cfg.hasLegalHold);
        const allNonHeldSucceed = serviceConfigs
          .filter((cfg) => !cfg.hasLegalHold)
          .every((cfg) => cfg.succeeds);

        const expectedFullyCompleted = allNonHeldSucceed && !hasAnyHold;

        expect(result.fully_completed).toBe(expectedFullyCompleted);
      }),
      { numRuns: 100 },
    );
  });
});
