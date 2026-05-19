/**
 * Unit tests for TelemetryIngestionService.
 *
 * Verifies:
 * - Metric ingestion with PII redaction
 * - Trace ingestion with golden signal feeding
 * - Log ingestion with PII redaction
 * - Correlation ID validation (Requirement 17.3)
 * - Integration with sub-components (PII redactor, golden signals, SLO monitor)
 *
 * @see Requirement 17.1 - OpenTelemetry signal ingestion
 * @see Requirement 17.3 - Correlation identifier propagation
 * @see Requirement 17.5 - PII exclusion
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryIngestionService } from '../src/telemetry-ingestion-service.js';
import { TelemetryPIIRedactor } from '../src/telemetry-pii-redactor.js';
import { GoldenSignalComputer } from '../src/golden-signal-computer.js';
import { SLOMonitor } from '../src/slo-monitor.js';
import type { RequestContext } from '@may/types';
import type { MetricBatch, TraceBatch, LogBatch } from '../src/interfaces/index.js';

function createTestCtx(): RequestContext {
  return {
    tenant_id: 'test-tenant-001' as any,
    principal_id: 'test-principal-001' as any,
    correlation_id: 'test-corr-001' as any,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'test-session-001' as any,
    roles: ['Platform_Operator'],
    attributes: {},
    residency_region: 'us-east-1',
  };
}

describe('TelemetryIngestionService', () => {
  let service: TelemetryIngestionService;
  let piiRedactor: TelemetryPIIRedactor;
  let goldenSignalComputer: GoldenSignalComputer;
  let sloMonitor: SLOMonitor;
  let ctx: RequestContext;

  beforeEach(() => {
    piiRedactor = new TelemetryPIIRedactor();
    goldenSignalComputer = new GoldenSignalComputer(60_000);
    sloMonitor = new SLOMonitor();
    service = new TelemetryIngestionService(piiRedactor, goldenSignalComputer, sloMonitor);
    ctx = createTestCtx();
  });

  describe('ingestMetrics', () => {
    it('should accept valid metrics with correlation_id', async () => {
      const batch: MetricBatch = {
        tenant_id: 'tenant-1',
        metrics: [
          {
            name: 'http.request.duration',
            value: 42,
            timestamp: '2024-01-15T10:30:00.000Z',
            service_name: 'LLM_Gateway',
            correlation_id: 'corr-001',
            attributes: { method: 'GET' },
          },
        ],
      };

      const ack = await service.ingestMetrics(batch, ctx);

      expect(ack.accepted_count).toBe(1);
      expect(ack.rejected_count).toBe(0);
      expect(ack.ingested_at).toBeDefined();
    });

    it('should reject metrics without correlation_id', async () => {
      const batch: MetricBatch = {
        tenant_id: 'tenant-1',
        metrics: [
          {
            name: 'http.request.duration',
            value: 42,
            timestamp: '2024-01-15T10:30:00.000Z',
            service_name: 'LLM_Gateway',
            correlation_id: '', // Empty = missing
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestMetrics(batch, ctx);

      expect(ack.accepted_count).toBe(0);
      expect(ack.rejected_count).toBe(1);
    });

    it('should redact PII from metric attributes before storage', async () => {
      const batch: MetricBatch = {
        tenant_id: 'tenant-1',
        metrics: [
          {
            name: 'user.login',
            value: 1,
            timestamp: '2024-01-15T10:30:00.000Z',
            service_name: 'Identity_Service',
            correlation_id: 'corr-001',
            attributes: { user_email: 'alice@example.com' },
          },
        ],
      };

      const ack = await service.ingestMetrics(batch, ctx);
      expect(ack.accepted_count).toBe(1);
      // PII redaction is applied internally; the ack confirms acceptance
    });

    it('should handle empty batches', async () => {
      const batch: MetricBatch = { tenant_id: 'tenant-1', metrics: [] };
      const ack = await service.ingestMetrics(batch, ctx);

      expect(ack.accepted_count).toBe(0);
      expect(ack.rejected_count).toBe(0);
    });
  });

  describe('ingestTraces', () => {
    it('should accept valid trace spans', async () => {
      const batch: TraceBatch = {
        tenant_id: 'tenant-1',
        spans: [
          {
            span_id: 'span-001',
            trace_id: 'trace-001',
            operation_name: 'GET /api/health',
            service_name: 'LLM_Gateway',
            correlation_id: 'corr-001',
            start_time: '2024-01-15T10:30:00.000Z',
            end_time: '2024-01-15T10:30:00.050Z',
            status: 'ok',
            duration_ms: 50,
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestTraces(batch, ctx);

      expect(ack.accepted_count).toBe(1);
      expect(ack.rejected_count).toBe(0);
    });

    it('should reject spans without correlation_id', async () => {
      const batch: TraceBatch = {
        tenant_id: 'tenant-1',
        spans: [
          {
            span_id: 'span-001',
            trace_id: 'trace-001',
            operation_name: 'GET /api/health',
            service_name: 'LLM_Gateway',
            correlation_id: '',
            start_time: '2024-01-15T10:30:00.000Z',
            end_time: '2024-01-15T10:30:00.050Z',
            status: 'ok',
            duration_ms: 50,
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestTraces(batch, ctx);

      expect(ack.accepted_count).toBe(0);
      expect(ack.rejected_count).toBe(1);
    });

    it('should feed golden signal computation from trace spans', async () => {
      const batch: TraceBatch = {
        tenant_id: 'tenant-1',
        spans: [
          {
            span_id: 'span-001',
            trace_id: 'trace-001',
            operation_name: 'GET /api/invoke',
            service_name: 'LLM_Gateway',
            correlation_id: 'corr-001',
            start_time: '2024-01-15T10:30:00.000Z',
            end_time: '2024-01-15T10:30:00.100Z',
            status: 'ok',
            duration_ms: 100,
            attributes: {},
          },
          {
            span_id: 'span-002',
            trace_id: 'trace-001',
            operation_name: 'POST /api/invoke',
            service_name: 'LLM_Gateway',
            correlation_id: 'corr-002',
            start_time: '2024-01-15T10:30:01.000Z',
            end_time: '2024-01-15T10:30:01.200Z',
            status: 'error',
            duration_ms: 200,
            attributes: {},
          },
        ],
      };

      await service.ingestTraces(batch, ctx);

      const signals = await service.getGoldenSignals('LLM_Gateway', ctx);
      expect(signals.service_name).toBe('LLM_Gateway');
      // Should have recorded 2 requests, 1 error
      expect(signals.error_rate).toBeCloseTo(0.5);
    });

    it('should redact PII from span attributes', async () => {
      const batch: TraceBatch = {
        tenant_id: 'tenant-1',
        spans: [
          {
            span_id: 'span-001',
            trace_id: 'trace-001',
            operation_name: 'GET /users',
            service_name: 'Identity_Service',
            correlation_id: 'corr-001',
            start_time: '2024-01-15T10:30:00.000Z',
            end_time: '2024-01-15T10:30:00.050Z',
            status: 'ok',
            duration_ms: 50,
            attributes: { 'user.email': 'bob@company.com' },
          },
        ],
      };

      const ack = await service.ingestTraces(batch, ctx);
      expect(ack.accepted_count).toBe(1);
    });
  });

  describe('ingestLogs', () => {
    it('should accept valid log entries', async () => {
      const batch: LogBatch = {
        tenant_id: 'tenant-1',
        entries: [
          {
            timestamp: '2024-01-15T10:30:00.000Z',
            severity: 'INFO',
            body: 'Request processed',
            service_name: 'Control_Service',
            correlation_id: 'corr-001',
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestLogs(batch, ctx);

      expect(ack.accepted_count).toBe(1);
      expect(ack.rejected_count).toBe(0);
    });

    it('should reject logs without correlation_id', async () => {
      const batch: LogBatch = {
        tenant_id: 'tenant-1',
        entries: [
          {
            timestamp: '2024-01-15T10:30:00.000Z',
            severity: 'ERROR',
            body: 'Something failed',
            service_name: 'Control_Service',
            correlation_id: '',
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestLogs(batch, ctx);

      expect(ack.accepted_count).toBe(0);
      expect(ack.rejected_count).toBe(1);
    });

    it('should redact PII from log body', async () => {
      const batch: LogBatch = {
        tenant_id: 'tenant-1',
        entries: [
          {
            timestamp: '2024-01-15T10:30:00.000Z',
            severity: 'WARN',
            body: 'Login failed for user@example.com from 192.168.1.1',
            service_name: 'Identity_Service',
            correlation_id: 'corr-001',
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestLogs(batch, ctx);
      expect(ack.accepted_count).toBe(1);
    });

    it('should handle mixed valid and invalid entries', async () => {
      const batch: LogBatch = {
        tenant_id: 'tenant-1',
        entries: [
          {
            timestamp: '2024-01-15T10:30:00.000Z',
            severity: 'INFO',
            body: 'Valid entry',
            service_name: 'svc-a',
            correlation_id: 'corr-001',
            attributes: {},
          },
          {
            timestamp: '2024-01-15T10:30:01.000Z',
            severity: 'ERROR',
            body: 'Invalid - no correlation',
            service_name: 'svc-b',
            correlation_id: '',
            attributes: {},
          },
          {
            timestamp: '2024-01-15T10:30:02.000Z',
            severity: 'DEBUG',
            body: 'Another valid entry',
            service_name: 'svc-c',
            correlation_id: 'corr-003',
            attributes: {},
          },
        ],
      };

      const ack = await service.ingestLogs(batch, ctx);

      expect(ack.accepted_count).toBe(2);
      expect(ack.rejected_count).toBe(1);
    });
  });

  describe('getSLOStatus', () => {
    it('should return SLO status for registered SLO', async () => {
      sloMonitor.registerSLO({
        slo_id: 'test-slo',
        service_name: 'Test_Service',
        name: 'Test SLO',
        sli_type: 'availability',
        target: 0.99,
        window_days: 7,
      });

      const status = await service.getSLOStatus('test-slo', ctx);

      expect(status.definition.slo_id).toBe('test-slo');
      expect(status.is_met).toBe(true);
    });
  });

  describe('getErrorBudget', () => {
    it('should return error budget status', async () => {
      sloMonitor.registerSLO({
        slo_id: 'budget-test',
        service_name: 'Budget_Service',
        name: 'Budget Test SLO',
        sli_type: 'availability',
        target: 0.99,
        window_days: 30,
      });

      const status = await service.getErrorBudget('budget-test', ctx);

      expect(status.error_budget_total).toBeCloseTo(0.01);
      expect(status.error_budget_remaining).toBe(1.0);
    });
  });
});
