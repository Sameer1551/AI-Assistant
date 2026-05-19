/**
 * @module telemetry-service
 * ITelemetryService — main interface for the Telemetry_Service.
 *
 * Provides OpenTelemetry signal ingestion (metrics, traces, logs),
 * golden signal computation, SLO monitoring, and PII redaction.
 *
 * @see Requirement 17 - Telemetry, Metrics, Logs, and Traces
 * @see Requirement 18 - Service Level Objectives
 */

import type { RequestContext } from '@may/types';
import type { PIICategory } from '@may/types';

// ─── Metric Types ────────────────────────────────────────────────────────────

/**
 * A single metric data point in the OpenTelemetry data model.
 */
export interface MetricDataPoint {
  /** Metric name (e.g., "http.server.request.duration") */
  readonly name: string;
  /** Metric value */
  readonly value: number;
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Service that emitted this metric */
  readonly service_name: string;
  /** Correlation identifier */
  readonly correlation_id: string;
  /** Additional labels/attributes */
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * A batch of metrics for ingestion.
 */
export interface MetricBatch {
  readonly metrics: readonly MetricDataPoint[];
  readonly tenant_id: string;
}

// ─── Trace Types ─────────────────────────────────────────────────────────────

/**
 * A single span in a distributed trace.
 */
export interface TraceSpan {
  /** Unique span identifier */
  readonly span_id: string;
  /** Trace identifier (groups all spans for a request) */
  readonly trace_id: string;
  /** Parent span identifier (empty for root spans) */
  readonly parent_span_id?: string;
  /** Operation name */
  readonly operation_name: string;
  /** Service that produced this span */
  readonly service_name: string;
  /** Correlation identifier */
  readonly correlation_id: string;
  /** ISO 8601 start timestamp */
  readonly start_time: string;
  /** ISO 8601 end timestamp */
  readonly end_time: string;
  /** Span status: ok, error, unset */
  readonly status: 'ok' | 'error' | 'unset';
  /** Duration in milliseconds */
  readonly duration_ms: number;
  /** Span attributes */
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * A batch of trace spans for ingestion.
 */
export interface TraceBatch {
  readonly spans: readonly TraceSpan[];
  readonly tenant_id: string;
}

// ─── Log Types ───────────────────────────────────────────────────────────────

/** Log severity levels aligned with OpenTelemetry. */
export type LogSeverity = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/**
 * A single structured log entry.
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Log severity */
  readonly severity: LogSeverity;
  /** Log message body */
  readonly body: string;
  /** Service that emitted this log */
  readonly service_name: string;
  /** Correlation identifier */
  readonly correlation_id: string;
  /** Trace identifier for correlation with traces */
  readonly trace_id?: string;
  /** Span identifier for correlation with traces */
  readonly span_id?: string;
  /** Additional structured attributes */
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * A batch of log entries for ingestion.
 */
export interface LogBatch {
  readonly entries: readonly LogEntry[];
  readonly tenant_id: string;
}

// ─── Ingestion Acknowledgment ────────────────────────────────────────────────

/**
 * Acknowledgment returned after successful signal ingestion.
 */
export interface IngestAck {
  /** Number of data points accepted */
  readonly accepted_count: number;
  /** Number of data points rejected (e.g., due to PII redaction) */
  readonly rejected_count: number;
  /** ISO 8601 timestamp of ingestion */
  readonly ingested_at: string;
}

// ─── Golden Signals ──────────────────────────────────────────────────────────

/**
 * Golden signals computed for a service.
 * @see Requirement 17.4 - Standard golden signals per service
 */
export interface GoldenSignals {
  /** Service name */
  readonly service_name: string;
  /** Request rate (requests per second) */
  readonly rate: number;
  /** Error rate (fraction of requests that are errors, 0.0 to 1.0) */
  readonly error_rate: number;
  /** Latency percentiles in milliseconds */
  readonly latency_p50: number;
  readonly latency_p95: number;
  readonly latency_p99: number;
  /** Saturation indicators */
  readonly saturation: SaturationIndicators;
  /** Measurement window start (ISO 8601) */
  readonly window_start: string;
  /** Measurement window end (ISO 8601) */
  readonly window_end: string;
}

/**
 * Saturation indicators for a service.
 */
export interface SaturationIndicators {
  /** CPU utilization (0.0 to 1.0) */
  readonly cpu: number;
  /** Memory utilization (0.0 to 1.0) */
  readonly memory: number;
  /** Queue depth (absolute count) */
  readonly queue_depth: number;
}

// ─── SLO Types ───────────────────────────────────────────────────────────────

/**
 * An SLO definition specifying the target for a service.
 * @see Requirement 18.1
 */
export interface SLODefinition {
  /** Unique SLO identifier */
  readonly slo_id: string;
  /** Service this SLO applies to */
  readonly service_name: string;
  /** Human-readable SLO name */
  readonly name: string;
  /** The SLI type being measured */
  readonly sli_type: 'availability' | 'latency' | 'durability' | 'error_rate';
  /** Target value (e.g., 0.999 for 99.9% availability) */
  readonly target: number;
  /** Measurement window in days */
  readonly window_days: number;
}

/**
 * Current SLO status including error budget.
 * @see Requirement 18.3
 */
export interface SLOStatus {
  /** The SLO definition */
  readonly definition: SLODefinition;
  /** Current SLI value */
  readonly current_sli: number;
  /** Whether the SLO is currently met */
  readonly is_met: boolean;
  /** Remaining error budget as a fraction (0.0 to 1.0) */
  readonly error_budget_remaining: number;
  /** Total error budget for the window */
  readonly error_budget_total: number;
  /** Error budget consumed so far */
  readonly error_budget_consumed: number;
  /** Last computation timestamp (ISO 8601) */
  readonly computed_at: string;
}

// ─── Alert Types ─────────────────────────────────────────────────────────────

/** Alert severity levels. */
export type AlertSeverity = 'warning' | 'high' | 'critical';

/**
 * An alert emitted by the telemetry service.
 * @see Requirement 18.4, 18.5
 */
export interface TelemetryAlert {
  /** Unique alert identifier */
  readonly alert_id: string;
  /** Alert severity */
  readonly severity: AlertSeverity;
  /** Alert type */
  readonly type: 'budget_warning' | 'slo_breach';
  /** Related SLO identifier */
  readonly slo_id: string;
  /** Service name */
  readonly service_name: string;
  /** Human-readable message */
  readonly message: string;
  /** Current error budget remaining (fraction) */
  readonly error_budget_remaining: number;
  /** ISO 8601 timestamp */
  readonly emitted_at: string;
}

// ─── Service Interface ───────────────────────────────────────────────────────

/**
 * Main Telemetry_Service interface.
 *
 * @see Requirement 17.1 - OpenTelemetry signal ingestion
 * @see Requirement 17.2 - Ingest, store, and query signals
 * @see Requirement 17.3 - Correlation identifier propagation
 * @see Requirement 17.4 - Golden signals per service
 * @see Requirement 17.5 - PII exclusion from telemetry
 * @see Requirement 18.3 - SLO computation every ≤5 min
 * @see Requirement 18.4 - Budget-warning alert at 25% remaining
 * @see Requirement 18.5 - High-severity alert on SLO breach
 */
export interface ITelemetryService {
  /**
   * Ingests a batch of metrics.
   * Applies PII redaction before storage.
   */
  ingestMetrics(batch: MetricBatch, ctx: RequestContext): Promise<IngestAck>;

  /**
   * Ingests a batch of trace spans.
   * Applies PII redaction before storage.
   */
  ingestTraces(batch: TraceBatch, ctx: RequestContext): Promise<IngestAck>;

  /**
   * Ingests a batch of log entries.
   * Applies PII redaction before storage.
   */
  ingestLogs(batch: LogBatch, ctx: RequestContext): Promise<IngestAck>;

  /**
   * Gets the current golden signals for a service.
   */
  getGoldenSignals(serviceName: string, ctx: RequestContext): Promise<GoldenSignals>;

  /**
   * Gets the current SLO status for a service.
   */
  getSLOStatus(sloId: string, ctx: RequestContext): Promise<SLOStatus>;

  /**
   * Gets the error budget status for a service.
   */
  getErrorBudget(sloId: string, ctx: RequestContext): Promise<SLOStatus>;
}

// ─── Sub-Component Interfaces ────────────────────────────────────────────────

/**
 * Computes golden signals from ingested telemetry data.
 * @see Requirement 17.4
 */
export interface IGoldenSignalComputer {
  /**
   * Records a request for golden signal computation.
   */
  recordRequest(serviceName: string, durationMs: number, isError: boolean): void;

  /**
   * Records saturation metrics for a service.
   */
  recordSaturation(serviceName: string, saturation: SaturationIndicators): void;

  /**
   * Computes current golden signals for a service.
   */
  compute(serviceName: string): GoldenSignals;
}

/**
 * Monitors SLOs and emits alerts when error budgets are low or breached.
 * @see Requirement 18.3, 18.4, 18.5
 */
export interface ISLOMonitor {
  /**
   * Registers an SLO definition for monitoring.
   */
  registerSLO(definition: SLODefinition): void;

  /**
   * Records an SLI observation (e.g., a request success/failure).
   */
  recordObservation(sloId: string, success: boolean): void;

  /**
   * Computes current SLO status and emits alerts if needed.
   * Should be called at intervals ≤5 minutes.
   */
  computeStatus(sloId: string): SLOStatus;

  /**
   * Gets all alerts emitted since last check.
   */
  getAlerts(): readonly TelemetryAlert[];

  /**
   * Clears emitted alerts after they have been consumed.
   */
  clearAlerts(): void;
}

/**
 * Redacts PII from telemetry data before storage.
 * @see Requirement 17.5
 */
export interface ITelemetryPIIRedactor {
  /**
   * Redacts PII from a metric data point's attributes.
   * Returns the redacted metric and whether any PII was found.
   */
  redactMetric(metric: MetricDataPoint): { redacted: MetricDataPoint; piiFound: boolean };

  /**
   * Redacts PII from a trace span's attributes and operation name.
   * Returns the redacted span and whether any PII was found.
   */
  redactSpan(span: TraceSpan): { redacted: TraceSpan; piiFound: boolean };

  /**
   * Redacts PII from a log entry's body and attributes.
   * Returns the redacted entry and whether any PII was found.
   */
  redactLogEntry(entry: LogEntry): { redacted: LogEntry; piiFound: boolean };

  /**
   * Redacts PII from a string value.
   * Returns the redacted string.
   */
  redactString(value: string): string;

  /**
   * Gets the PII categories that are prohibited in telemetry.
   */
  getProhibitedCategories(): readonly PIICategory[];
}
