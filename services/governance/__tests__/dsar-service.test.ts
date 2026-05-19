/**
 * Unit tests for DSARService.
 *
 * Verifies:
 * - DSAR submission and auto-acknowledgment (Req 27.1, 27.2)
 * - Acknowledgment within 72h deadline (Req 27.2)
 * - Erasure order issuance to all owning services (Req 27.3)
 * - Per-service completion tracking (Req 27.3)
 * - Legal hold exclusion with documented basis (Req 27.4)
 * - Machine-readable export generation (Req 27.5)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { DSARService } from '../src/dsar-service.js';
import { InMemoryDSARStore } from '../src/in-memory-dsar-store.js';
import type {
  IDataOwningService,
  ILegalHoldChecker,
  IDSARClock,
  IDSARIdGenerator,
  LegalHoldExclusion,
  SubmitDSARRequest,
} from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class StubClock implements IDSARClock {
  private currentTime: string = '2024-06-15T10:00:00.000Z';

  now(): string {
    return this.currentTime;
  }

  setTime(iso: string): void {
    this.currentTime = iso;
  }

  advanceHours(hours: number): void {
    const date = new Date(this.currentTime);
    date.setTime(date.getTime() + hours * 60 * 60 * 1000);
    this.currentTime = date.toISOString();
  }
}

class StubIdGenerator implements IDSARIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `dsar-${this.counter.toString().padStart(4, '0')}`;
  }
}

class StubDataOwningService implements IDataOwningService {
  readonly serviceName: string;
  private shouldSucceed: boolean;
  private exportPayload: Record<string, unknown>;

  constructor(
    name: string,
    shouldSucceed = true,
    exportPayload: Record<string, unknown> = {},
  ) {
    this.serviceName = name;
    this.shouldSucceed = shouldSucceed;
    this.exportPayload = exportPayload;
  }

  async executeErasure(_dataSubjectId: string, _tenantId: string): Promise<boolean> {
    return this.shouldSucceed;
  }

  async exportData(_dataSubjectId: string, _tenantId: string): Promise<Record<string, unknown>> {
    return this.exportPayload;
  }

  setSuccess(value: boolean): void {
    this.shouldSucceed = value;
  }

  setExportPayload(payload: Record<string, unknown>): void {
    this.exportPayload = payload;
  }
}

class StubLegalHoldChecker implements ILegalHoldChecker {
  private holds: Map<string, LegalHoldExclusion> = new Map();

  async checkHold(
    serviceName: string,
    _dataSubjectId: string,
    _tenantId: string,
  ): Promise<LegalHoldExclusion | null> {
    return this.holds.get(serviceName) ?? null;
  }

  addHold(serviceName: string, legalBasis: string): void {
    this.holds.set(serviceName, {
      service_name: serviceName,
      legal_basis: legalBasis,
      hold_applied_at: '2024-01-01T00:00:00.000Z',
    });
  }

  removeHold(serviceName: string): void {
    this.holds.delete(serviceName);
  }
}

function createTestContext(tenantId = 'tenant-1'): RequestContext {
  return {
    tenant_id: tenantId as TenantId,
    principal_id: 'principal-1' as PrincipalId,
    correlation_id: 'corr-123' as CorrelationId,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'session-1' as SessionId,
    roles: ['Tenant_Administrator'],
    attributes: {},
    residency_region: 'eu-west-1',
  };
}

function createErasureRequest(): SubmitDSARRequest {
  return {
    data_subject_id: 'subject-001',
    request_type: 'erasure',
  };
}

function createExportRequest(): SubmitDSARRequest {
  return {
    data_subject_id: 'subject-001',
    request_type: 'export',
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('DSARService', () => {
  let store: InMemoryDSARStore;
  let clock: StubClock;
  let idGenerator: StubIdGenerator;
  let memoryService: StubDataOwningService;
  let habitService: StubDataOwningService;
  let workflowService: StubDataOwningService;
  let telemetryService: StubDataOwningService;
  let legalHoldChecker: StubLegalHoldChecker;
  let service: DSARService;
  let ctx: RequestContext;

  beforeEach(() => {
    store = new InMemoryDSARStore();
    clock = new StubClock();
    idGenerator = new StubIdGenerator();
    memoryService = new StubDataOwningService('Memory_Service', true, {
      memories: ['mem-1', 'mem-2'],
    });
    habitService = new StubDataOwningService('Habit_Service', true, {
      patterns: ['pattern-1'],
    });
    workflowService = new StubDataOwningService('Workflow_Service', true, {
      workflows: ['wf-1'],
    });
    telemetryService = new StubDataOwningService('Telemetry_Service', true, {
      logs: ['log-1'],
    });
    legalHoldChecker = new StubLegalHoldChecker();

    const dataOwningServices = [
      memoryService,
      habitService,
      workflowService,
      telemetryService,
    ];

    service = new DSARService(
      store,
      dataOwningServices,
      legalHoldChecker,
      clock,
      idGenerator,
    );

    ctx = createTestContext();
  });

  // ─── Submit Request ──────────────────────────────────────────────────────

  describe('submitRequest', () => {
    it('should create a DSAR and return acknowledgment', async () => {
      const request = createErasureRequest();
      const ack = await service.submitRequest(request, ctx);

      expect(ack.dsar_id).toBe('dsar-0001');
      expect(ack.acknowledged_at).toBe('2024-06-15T10:00:00.000Z');
      expect(ack.status).toBe('acknowledged');
    });

    it('should set due date to 30 calendar days from submission', async () => {
      const request = createErasureRequest();
      const ack = await service.submitRequest(request, ctx);

      const submitted = new Date('2024-06-15T10:00:00.000Z');
      const due = new Date(ack.due_date);
      const diffDays = Math.round(
        (due.getTime() - submitted.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(30);
    });

    it('should auto-acknowledge on submission (within 72h requirement)', async () => {
      const request = createErasureRequest();
      const ack = await service.submitRequest(request, ctx);

      expect(ack.status).toBe('acknowledged');
      expect(ack.acknowledged_at).toBeDefined();
    });

    it('should persist the DSAR in the store', async () => {
      const request = createErasureRequest();
      const ack = await service.submitRequest(request, ctx);

      const stored = await store.findById(ack.dsar_id, 'tenant-1');
      expect(stored).not.toBeNull();
      expect(stored!.data_subject_id).toBe('subject-001');
      expect(stored!.request_type).toBe('erasure');
      expect(stored!.tenant_id).toBe('tenant-1');
    });

    it('should support all DSAR request types', async () => {
      const types = ['access', 'rectification', 'export', 'erasure'] as const;

      for (const type of types) {
        const ack = await service.submitRequest(
          { data_subject_id: 'subject-001', request_type: type },
          ctx,
        );
        expect(ack.status).toBe('acknowledged');
      }
    });

    it('should reject request with empty data_subject_id', async () => {
      const request: SubmitDSARRequest = {
        data_subject_id: '',
        request_type: 'erasure',
      };

      await expect(service.submitRequest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should reject request with invalid request_type', async () => {
      const request = {
        data_subject_id: 'subject-001',
        request_type: 'invalid' as never,
      };

      await expect(service.submitRequest(request, ctx)).rejects.toMatchObject({
        category: 'VALIDATION',
      });
    });

    it('should isolate DSARs by tenant', async () => {
      await service.submitRequest(createErasureRequest(), ctx);

      const ctx2 = createTestContext('tenant-2');
      const result = await service.getRequest('dsar-0001', ctx2);
      expect(result).toBeNull();
    });
  });

  // ─── Acknowledge ─────────────────────────────────────────────────────────

  describe('acknowledge', () => {
    it('should return existing acknowledgment for already-acknowledged DSAR', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const reAck = await service.acknowledge(ack.dsar_id, ctx);

      expect(reAck.status).toBe('acknowledged');
      expect(reAck.dsar_id).toBe(ack.dsar_id);
    });

    it('should throw NOT_FOUND for non-existent DSAR', async () => {
      await expect(service.acknowledge('non-existent', ctx)).rejects.toMatchObject({
        category: 'NOT_FOUND',
      });
    });
  });

  // ─── Process Erasure ─────────────────────────────────────────────────────

  describe('processErasure', () => {
    it('should issue erasure orders to all owning services', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.processErasure(ack.dsar_id, ctx);

      expect(result.service_completion['Memory_Service']).toBe(true);
      expect(result.service_completion['Habit_Service']).toBe(true);
      expect(result.service_completion['Workflow_Service']).toBe(true);
      expect(result.service_completion['Telemetry_Service']).toBe(true);
    });

    it('should mark as fully completed when all services succeed', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.processErasure(ack.dsar_id, ctx);

      expect(result.fully_completed).toBe(true);
      expect(result.legal_hold_exclusions).toHaveLength(0);
    });

    it('should track per-service completion status', async () => {
      // Make one service fail
      workflowService.setSuccess(false);

      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.processErasure(ack.dsar_id, ctx);

      expect(result.service_completion['Memory_Service']).toBe(true);
      expect(result.service_completion['Habit_Service']).toBe(true);
      expect(result.service_completion['Workflow_Service']).toBe(false);
      expect(result.service_completion['Telemetry_Service']).toBe(true);
      expect(result.fully_completed).toBe(false);
    });

    it('should exclude services under legal hold', async () => {
      legalHoldChecker.addHold(
        'Memory_Service',
        'Litigation hold - Case #2024-001',
      );

      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.processErasure(ack.dsar_id, ctx);

      expect(result.legal_hold_exclusions).toHaveLength(1);
      expect(result.legal_hold_exclusions[0]!.service_name).toBe('Memory_Service');
      expect(result.legal_hold_exclusions[0]!.legal_basis).toBe(
        'Litigation hold - Case #2024-001',
      );
      // Memory_Service should be marked as not completed (excluded)
      expect(result.service_completion['Memory_Service']).toBe(false);
      // Other services should still complete
      expect(result.service_completion['Habit_Service']).toBe(true);
    });

    it('should mark as partially_completed when legal holds exist but others succeed', async () => {
      legalHoldChecker.addHold(
        'Telemetry_Service',
        'Regulatory retention requirement',
      );

      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.processErasure(ack.dsar_id, ctx);

      // Check the stored DSAR status
      const stored = await service.getRequest(ack.dsar_id, ctx);
      expect(stored!.status).toBe('partially_completed');
      expect(result.fully_completed).toBe(false);
    });

    it('should update DSAR status to completed when all non-held services succeed', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);
      await service.processErasure(ack.dsar_id, ctx);

      const stored = await service.getRequest(ack.dsar_id, ctx);
      expect(stored!.status).toBe('completed');
    });

    it('should reject erasure processing for non-erasure DSARs', async () => {
      const ack = await service.submitRequest(createExportRequest(), ctx);

      await expect(service.processErasure(ack.dsar_id, ctx)).rejects.toMatchObject({
        category: 'INVALID_REQUEST',
      });
    });

    it('should throw NOT_FOUND for non-existent DSAR', async () => {
      await expect(service.processErasure('non-existent', ctx)).rejects.toMatchObject({
        category: 'NOT_FOUND',
      });
    });

    it('should handle multiple legal holds across services', async () => {
      legalHoldChecker.addHold('Memory_Service', 'Case #001');
      legalHoldChecker.addHold('Telemetry_Service', 'Regulatory audit');

      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.processErasure(ack.dsar_id, ctx);

      expect(result.legal_hold_exclusions).toHaveLength(2);
      expect(result.service_completion['Memory_Service']).toBe(false);
      expect(result.service_completion['Telemetry_Service']).toBe(false);
      expect(result.service_completion['Habit_Service']).toBe(true);
      expect(result.service_completion['Workflow_Service']).toBe(true);
    });

    it('should persist service_completion in the DSAR record', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);
      await service.processErasure(ack.dsar_id, ctx);

      const stored = await service.getRequest(ack.dsar_id, ctx);
      expect(stored!.service_completion['Memory_Service']).toBe(true);
      expect(stored!.service_completion['Habit_Service']).toBe(true);
      expect(stored!.service_completion['Workflow_Service']).toBe(true);
      expect(stored!.service_completion['Telemetry_Service']).toBe(true);
    });
  });

  // ─── Generate Export ─────────────────────────────────────────────────────

  describe('generateExport', () => {
    it('should produce a machine-readable export in JSON format', async () => {
      const ack = await service.submitRequest(createExportRequest(), ctx);
      const result = await service.generateExport(ack.dsar_id, ctx);

      expect(result.format).toBe('application/json');
      expect(result.dsar_id).toBe(ack.dsar_id);
      expect(result.generated_at).toBeDefined();
    });

    it('should collect data from all owning services', async () => {
      const ack = await service.submitRequest(createExportRequest(), ctx);
      const result = await service.generateExport(ack.dsar_id, ctx);

      expect(result.data['Memory_Service']).toEqual({ memories: ['mem-1', 'mem-2'] });
      expect(result.data['Habit_Service']).toEqual({ patterns: ['pattern-1'] });
      expect(result.data['Workflow_Service']).toEqual({ workflows: ['wf-1'] });
      expect(result.data['Telemetry_Service']).toEqual({ logs: ['log-1'] });
    });

    it('should list contributing services', async () => {
      const ack = await service.submitRequest(createExportRequest(), ctx);
      const result = await service.generateExport(ack.dsar_id, ctx);

      expect(result.contributing_services).toContain('Memory_Service');
      expect(result.contributing_services).toContain('Habit_Service');
      expect(result.contributing_services).toContain('Workflow_Service');
      expect(result.contributing_services).toContain('Telemetry_Service');
    });

    it('should exclude services with no data from contributing list', async () => {
      telemetryService.setExportPayload({});

      const ack = await service.submitRequest(createExportRequest(), ctx);
      const result = await service.generateExport(ack.dsar_id, ctx);

      expect(result.contributing_services).not.toContain('Telemetry_Service');
      expect(result.data['Telemetry_Service']).toBeUndefined();
    });

    it('should also work for access request type', async () => {
      const ack = await service.submitRequest(
        { data_subject_id: 'subject-001', request_type: 'access' },
        ctx,
      );
      const result = await service.generateExport(ack.dsar_id, ctx);

      expect(result.format).toBe('application/json');
      expect(result.contributing_services.length).toBeGreaterThan(0);
    });

    it('should reject export for erasure DSARs', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);

      await expect(service.generateExport(ack.dsar_id, ctx)).rejects.toMatchObject({
        category: 'INVALID_REQUEST',
      });
    });

    it('should reject export for rectification DSARs', async () => {
      const ack = await service.submitRequest(
        { data_subject_id: 'subject-001', request_type: 'rectification' },
        ctx,
      );

      await expect(service.generateExport(ack.dsar_id, ctx)).rejects.toMatchObject({
        category: 'INVALID_REQUEST',
      });
    });

    it('should throw NOT_FOUND for non-existent DSAR', async () => {
      await expect(service.generateExport('non-existent', ctx)).rejects.toMatchObject({
        category: 'NOT_FOUND',
      });
    });

    it('should update DSAR status to completed after export', async () => {
      const ack = await service.submitRequest(createExportRequest(), ctx);
      await service.generateExport(ack.dsar_id, ctx);

      const stored = await service.getRequest(ack.dsar_id, ctx);
      expect(stored!.status).toBe('completed');
    });
  });

  // ─── Get Request ─────────────────────────────────────────────────────────

  describe('getRequest', () => {
    it('should return the DSAR for the correct tenant', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);
      const result = await service.getRequest(ack.dsar_id, ctx);

      expect(result).not.toBeNull();
      expect(result!.dsar_id).toBe(ack.dsar_id);
      expect(result!.tenant_id).toBe('tenant-1');
    });

    it('should return null for non-existent DSAR', async () => {
      const result = await service.getRequest('non-existent', ctx);
      expect(result).toBeNull();
    });

    it('should enforce tenant isolation', async () => {
      const ack = await service.submitRequest(createErasureRequest(), ctx);

      const ctx2 = createTestContext('tenant-2');
      const result = await service.getRequest(ack.dsar_id, ctx2);
      expect(result).toBeNull();
    });
  });

  // ─── Due Date Compliance ─────────────────────────────────────────────────

  describe('due date compliance', () => {
    it('should set due date exactly 30 days from submission', async () => {
      clock.setTime('2024-01-01T00:00:00.000Z');
      const ack = await service.submitRequest(createErasureRequest(), ctx);

      const dueDate = new Date(ack.due_date);
      expect(dueDate.toISOString()).toBe('2024-01-31T00:00:00.000Z');
    });

    it('should handle month boundaries correctly', async () => {
      clock.setTime('2024-02-15T12:00:00.000Z');
      const ack = await service.submitRequest(createErasureRequest(), ctx);

      const dueDate = new Date(ack.due_date);
      expect(dueDate.toISOString()).toBe('2024-03-16T12:00:00.000Z');
    });
  });
});
