/**
 * Telemetry service interfaces.
 * Service contracts and dependency injection interfaces.
 *
 * @see Requirement 17 - Telemetry, Metrics, Logs, and Traces
 * @see Requirement 18 - Service Level Objectives
 */

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
} from './telemetry-service.js';
