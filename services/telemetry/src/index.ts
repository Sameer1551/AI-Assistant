/**
 * @may/telemetry - Telemetry Service
 *
 * OpenTelemetry signal ingestion, golden signal computation,
 * SLO monitoring with error budget tracking, and PII redaction.
 *
 * @see Requirement 17 - Telemetry, Metrics, Logs, and Traces
 * @see Requirement 18 - Service Level Objectives
 */

// Interfaces and types
export type {
  MetricDataPoint,
  MetricBatch,
  TraceSpan,
  TraceBatch,
  LogSeverity,
  LogEntry,
  LogBatch,
  IngestAck,
  GoldenSignals,
  SaturationIndicators,
  SLODefinition,
  SLOStatus,
  AlertSeverity,
  TelemetryAlert,
  ITelemetryService,
  IGoldenSignalComputer,
  ISLOMonitor,
  ITelemetryPIIRedactor,
} from './interfaces/index.js';

// Implementations
export { TelemetryIngestionService } from './telemetry-ingestion-service.js';
export { GoldenSignalComputer } from './golden-signal-computer.js';
export { SLOMonitor } from './slo-monitor.js';
export { TelemetryPIIRedactor } from './telemetry-pii-redactor.js';
