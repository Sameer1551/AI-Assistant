/**
 * @module telemetry-ingestion-service
 * TelemetryIngestionService — main service implementation for telemetry ingestion.
 *
 * Orchestrates OpenTelemetry signal ingestion (metrics, traces, logs),
 * applies PII redaction, feeds golden signal computation, and records SLO observations.
 *
 * @see Requirement 17.1 - OpenTelemetry data model
 * @see Requirement 17.2 - Ingest, store, and query
 * @see Requirement 17.3 - Correlation identifier propagation
 * @see Requirement 17.5 - PII exclusion
 */

import type { RequestContext } from '@may/types';
import type {
  ITelemetryService,
  IGoldenSignalComputer,
  ISLOMonitor,
  ITelemetryPIIRedactor,
  MetricBatch,
  TraceBatch,
  LogBatch,
  IngestAck,
  GoldenSignals,
  SLOStatus,
  MetricDataPoint,
  TraceSpan,
  LogEntry,
} from './interfaces/index.js';

/**
 * TelemetryIngestionService implementation.
 *
 * Uses dependency injection for all sub-components:
 * - ITelemetryPIIRedactor for PII stripping
 * - IGoldenSignalComputer for golden signal computation
 * - ISLOMonitor for SLO tracking and alerting
 */
export class TelemetryIngestionService implements ITelemetryService {
  private readonly storedMetrics: MetricDataPoint[] = [];
  private readonly storedSpans: TraceSpan[] = [];
  private readonly storedLogs: LogEntry[] = [];

  constructor(
    private readonly piiRedactor: ITelemetryPIIRedactor,
    private readonly goldenSignalComputer: IGoldenSignalComputer,
    private readonly sloMonitor: ISLOMonitor,
  ) {}

  async ingestMetrics(batch: MetricBatch, _ctx: RequestContext): Promise<IngestAck> {
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (const metric of batch.metrics) {
      // Validate correlation_id propagation (Requirement 17.3)
      if (!metric.correlation_id) {
        rejectedCount++;
        continue;
      }

      // Apply PII redaction (Requirement 17.5)
      const { redacted } = this.piiRedactor.redactMetric(metric);

      // Store the redacted metric
      this.storedMetrics.push(redacted);
      acceptedCount++;
    }

    return {
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      ingested_at: new Date().toISOString(),
    };
  }

  async ingestTraces(batch: TraceBatch, _ctx: RequestContext): Promise<IngestAck> {
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (const span of batch.spans) {
      // Validate correlation_id propagation (Requirement 17.3)
      if (!span.correlation_id) {
        rejectedCount++;
        continue;
      }

      // Apply PII redaction (Requirement 17.5)
      const { redacted } = this.piiRedactor.redactSpan(span);

      // Store the redacted span
      this.storedSpans.push(redacted);

      // Feed golden signal computation (Requirement 17.4)
      this.goldenSignalComputer.recordRequest(
        redacted.service_name,
        redacted.duration_ms,
        redacted.status === 'error',
      );

      // Record SLO observation for availability-type SLOs
      // The SLO monitor will only process if the SLO is registered
      this.recordSLOObservationFromSpan(redacted);

      acceptedCount++;
    }

    return {
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      ingested_at: new Date().toISOString(),
    };
  }

  async ingestLogs(batch: LogBatch, _ctx: RequestContext): Promise<IngestAck> {
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (const entry of batch.entries) {
      // Validate correlation_id propagation (Requirement 17.3)
      if (!entry.correlation_id) {
        rejectedCount++;
        continue;
      }

      // Apply PII redaction (Requirement 17.5)
      const { redacted } = this.piiRedactor.redactLogEntry(entry);

      // Store the redacted log entry
      this.storedLogs.push(redacted);
      acceptedCount++;
    }

    return {
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      ingested_at: new Date().toISOString(),
    };
  }

  async getGoldenSignals(serviceName: string, _ctx: RequestContext): Promise<GoldenSignals> {
    return this.goldenSignalComputer.compute(serviceName);
  }

  async getSLOStatus(sloId: string, _ctx: RequestContext): Promise<SLOStatus> {
    return this.sloMonitor.computeStatus(sloId);
  }

  async getErrorBudget(sloId: string, _ctx: RequestContext): Promise<SLOStatus> {
    return this.sloMonitor.computeStatus(sloId);
  }

  /**
   * Records an SLO observation based on a trace span.
   * Maps service availability to SLO success/failure.
   */
  private recordSLOObservationFromSpan(span: TraceSpan): void {
    // For availability SLOs, a non-error span is a success
    const success = span.status !== 'error';
    // Use service_name as a convention for SLO ID mapping
    // The SLO monitor will silently ignore unregistered SLO IDs
    this.sloMonitor.recordObservation(`${span.service_name}-availability`, success);
  }
}
