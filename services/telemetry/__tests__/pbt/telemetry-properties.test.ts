/**
 * Property-based tests for telemetry correlation identifier propagation
 * and PII exclusion.
 *
 * **Validates: Requirements 17.3, 17.5**
 *
 * Property 38: Correlation Identifier Propagation — correlation_id appears in
 *   every log, trace, and audit event for a request. Traces/logs without
 *   correlation_id are rejected (rejected_count > 0), those with correlation_id
 *   are accepted.
 *
 * Property 39: Telemetry PII Exclusion — prohibited PII categories redacted
 *   before emission. For any log/trace containing PII patterns (emails, phones,
 *   IPs, etc.), the stored data has PII replaced with [REDACTED].
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import type { RequestContext } from '@may/types';
import type { TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';
import { TelemetryIngestionService } from '../../src/telemetry-ingestion-service.js';
import { TelemetryPIIRedactor } from '../../src/telemetry-pii-redactor.js';
import { GoldenSignalComputer } from '../../src/golden-signal-computer.js';
import { SLOMonitor } from '../../src/slo-monitor.js';
import type {
  MetricBatch,
  TraceBatch,
  LogBatch,
  LogSeverity,
} from '../../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestContext(): RequestContext {
  return {
    tenant_id: 'test-tenant-001' as TenantId,
    principal_id: 'test-principal-001' as PrincipalId,
    correlation_id: 'test-corr-001' as CorrelationId,
    trace_context: { traceparent: '00-trace-id-span-id-01' },
    session_id: 'test-session-001' as SessionId,
    roles: ['Platform_Operator'],
    attributes: {},
    residency_region: 'us-east-1',
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for non-empty correlation IDs. */
const validCorrelationIdArb = fc.stringOf(
  fc.char().filter((c) => c.trim().length > 0 && c !== '\0'),
  { minLength: 1, maxLength: 40 },
).filter((s) => s.trim().length > 0);

/** Arbitrary for service names. */
const serviceNameArb = fc.constantFrom(
  'Identity_Service',
  'LLM_Gateway',
  'Control_Service',
  'Memory_Service',
  'Workflow_Service',
  'Audit_Service',
  'Telemetry_Service',
);

/** Arbitrary for ISO 8601 timestamps. */
const timestampArb = fc.date({
  min: new Date('2020-01-01T00:00:00Z'),
  max: new Date('2030-12-31T23:59:59Z'),
}).map((d) => d.toISOString());

/** Arbitrary for log severity. */
const logSeverityArb: fc.Arbitrary<LogSeverity> = fc.constantFrom(
  'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL',
);

/** Arbitrary for span status. */
const spanStatusArb = fc.constantFrom('ok' as const, 'error' as const, 'unset' as const);

/** Arbitrary for safe attribute values (no PII). */
const safeStringArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_- '.split('')),
  { minLength: 1, maxLength: 30 },
);

/** Arbitrary for safe attributes map. */
const safeAttributesArb = fc.dictionary(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_.'.split('')), { minLength: 1, maxLength: 15 }),
  safeStringArb,
  { minKeys: 0, maxKeys: 5 },
);

/** Arbitrary for a valid MetricDataPoint with correlation_id. */
const validMetricArb = fc.record({
  name: fc.constantFrom('http.request.duration', 'cpu.usage', 'memory.used', 'queue.depth'),
  value: fc.double({ min: 0, max: 10000, noNaN: true }),
  timestamp: timestampArb,
  service_name: serviceNameArb,
  correlation_id: validCorrelationIdArb,
  attributes: safeAttributesArb,
});

/** Arbitrary for a MetricDataPoint WITHOUT correlation_id (empty string). */
const invalidMetricArb = fc.record({
  name: fc.constantFrom('http.request.duration', 'cpu.usage'),
  value: fc.double({ min: 0, max: 10000, noNaN: true }),
  timestamp: timestampArb,
  service_name: serviceNameArb,
  correlation_id: fc.constant(''),
  attributes: safeAttributesArb,
});

/** Arbitrary for a valid TraceSpan with correlation_id. */
const validSpanArb = fc.record({
  span_id: fc.uuid(),
  trace_id: fc.uuid(),
  operation_name: fc.constantFrom('GET /api/health', 'POST /api/invoke', 'PUT /api/config'),
  service_name: serviceNameArb,
  correlation_id: validCorrelationIdArb,
  start_time: timestampArb,
  end_time: timestampArb,
  status: spanStatusArb,
  duration_ms: fc.nat({ max: 5000 }),
  attributes: safeAttributesArb,
});

/** Arbitrary for a TraceSpan WITHOUT correlation_id. */
const invalidSpanArb = fc.record({
  span_id: fc.uuid(),
  trace_id: fc.uuid(),
  operation_name: fc.constantFrom('GET /api/health', 'POST /api/invoke'),
  service_name: serviceNameArb,
  correlation_id: fc.constant(''),
  start_time: timestampArb,
  end_time: timestampArb,
  status: spanStatusArb,
  duration_ms: fc.nat({ max: 5000 }),
  attributes: safeAttributesArb,
});

/** Arbitrary for a valid LogEntry with correlation_id. */
const validLogEntryArb = fc.record({
  timestamp: timestampArb,
  severity: logSeverityArb,
  body: safeStringArb,
  service_name: serviceNameArb,
  correlation_id: validCorrelationIdArb,
  attributes: safeAttributesArb,
});

/** Arbitrary for a LogEntry WITHOUT correlation_id. */
const invalidLogEntryArb = fc.record({
  timestamp: timestampArb,
  severity: logSeverityArb,
  body: safeStringArb,
  service_name: serviceNameArb,
  correlation_id: fc.constant(''),
  attributes: safeAttributesArb,
});

// ─── PII Arbitraries for Property 39 ────────────────────────────────────────

/** Arbitrary for email addresses. */
const emailArb = fc.tuple(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 3, maxLength: 10 }),
  fc.constantFrom('example.com', 'company.org', 'test.net', 'mail.io'),
).map(([local, domain]) => `${local}@${domain}`);

/** Arbitrary for phone numbers. */
const phoneArb = fc.tuple(
  fc.integer({ min: 200, max: 999 }),
  fc.integer({ min: 200, max: 999 }),
  fc.integer({ min: 1000, max: 9999 }),
).map(([area, mid, last]) => `${area}-${mid}-${last}`);

/** Arbitrary for IP addresses. */
const ipAddressArb = fc.tuple(
  fc.integer({ min: 1, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 1, max: 254 }),
).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** Arbitrary for credit card numbers. */
const creditCardArb = fc.tuple(
  fc.integer({ min: 4000, max: 5999 }),
  fc.integer({ min: 1000, max: 9999 }),
  fc.integer({ min: 1000, max: 9999 }),
  fc.integer({ min: 1000, max: 9999 }),
).map(([a, b, c, d]) => `${a}-${b}-${c}-${d}`);

/** Arbitrary for SSN-like government IDs. */
const ssnArb = fc.tuple(
  fc.integer({ min: 100, max: 999 }),
  fc.integer({ min: 10, max: 99 }),
  fc.integer({ min: 1000, max: 9999 }),
).map(([a, b, c]) => `${a}-${b}-${c}`);

/** Arbitrary that picks one PII value from the available categories. */
const piiValueArb = fc.oneof(
  emailArb,
  phoneArb,
  ipAddressArb,
  creditCardArb,
  ssnArb,
);

/** Arbitrary for a string that contains embedded PII. */
const stringWithPIIArb = fc.tuple(
  fc.constantFrom('User logged in from ', 'Request by ', 'Error for user ', 'Connection from '),
  piiValueArb,
  fc.constantFrom(' at endpoint /api', ' failed', ' succeeded', ''),
).map(([prefix, pii, suffix]) => `${prefix}${pii}${suffix}`);

/** Arbitrary for attributes containing PII values. */
const piiAttributesArb = fc.dictionary(
  fc.constantFrom('user_email', 'client_ip', 'user_phone', 'card_number', 'user_ssn'),
  piiValueArb,
  { minKeys: 1, maxKeys: 3 },
);

// ─── Property 38: Correlation Identifier Propagation ─────────────────────────

describe('Property 38: Correlation Identifier Propagation', () => {
  let service: TelemetryIngestionService;
  let ctx: RequestContext;

  beforeEach(() => {
    const piiRedactor = new TelemetryPIIRedactor();
    const goldenSignalComputer = new GoldenSignalComputer(60_000);
    const sloMonitor = new SLOMonitor();
    service = new TelemetryIngestionService(piiRedactor, goldenSignalComputer, sloMonitor);
    ctx = createTestContext();
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY batch of metrics with valid correlation_ids, ALL metrics
   * are accepted (accepted_count equals batch size, rejected_count is 0).
   */
  it('accepts all metrics that have a valid correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validMetricArb, { minLength: 1, maxLength: 20 }),
        async (metrics) => {
          const batch: MetricBatch = { tenant_id: 'tenant-1', metrics };
          const ack = await service.ingestMetrics(batch, ctx);

          expect(ack.accepted_count).toBe(metrics.length);
          expect(ack.rejected_count).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY batch of metrics WITHOUT correlation_ids (empty string),
   * ALL metrics are rejected (rejected_count equals batch size, accepted_count is 0).
   */
  it('rejects all metrics that lack a correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(invalidMetricArb, { minLength: 1, maxLength: 20 }),
        async (metrics) => {
          const batch: MetricBatch = { tenant_id: 'tenant-1', metrics };
          const ack = await service.ingestMetrics(batch, ctx);

          expect(ack.accepted_count).toBe(0);
          expect(ack.rejected_count).toBe(metrics.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY batch of trace spans with valid correlation_ids, ALL spans
   * are accepted (accepted_count equals batch size, rejected_count is 0).
   */
  it('accepts all trace spans that have a valid correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validSpanArb, { minLength: 1, maxLength: 20 }),
        async (spans) => {
          const batch: TraceBatch = { tenant_id: 'tenant-1', spans };
          const ack = await service.ingestTraces(batch, ctx);

          expect(ack.accepted_count).toBe(spans.length);
          expect(ack.rejected_count).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY batch of trace spans WITHOUT correlation_ids,
   * ALL spans are rejected (rejected_count > 0).
   */
  it('rejects all trace spans that lack a correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(invalidSpanArb, { minLength: 1, maxLength: 20 }),
        async (spans) => {
          const batch: TraceBatch = { tenant_id: 'tenant-1', spans };
          const ack = await service.ingestTraces(batch, ctx);

          expect(ack.accepted_count).toBe(0);
          expect(ack.rejected_count).toBe(spans.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY batch of log entries with valid correlation_ids, ALL entries
   * are accepted (accepted_count equals batch size, rejected_count is 0).
   */
  it('accepts all log entries that have a valid correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validLogEntryArb, { minLength: 1, maxLength: 20 }),
        async (entries) => {
          const batch: LogBatch = { tenant_id: 'tenant-1', entries };
          const ack = await service.ingestLogs(batch, ctx);

          expect(ack.accepted_count).toBe(entries.length);
          expect(ack.rejected_count).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY batch of log entries WITHOUT correlation_ids,
   * ALL entries are rejected (rejected_count > 0).
   */
  it('rejects all log entries that lack a correlation_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(invalidLogEntryArb, { minLength: 1, maxLength: 20 }),
        async (entries) => {
          const batch: LogBatch = { tenant_id: 'tenant-1', entries };
          const ack = await service.ingestLogs(batch, ctx);

          expect(ack.accepted_count).toBe(0);
          expect(ack.rejected_count).toBe(entries.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.3**
   *
   * For ANY mixed batch containing both valid and invalid entries,
   * accepted_count + rejected_count equals total batch size, and
   * rejected_count equals the number of entries without correlation_id.
   */
  it('correctly partitions mixed batches by correlation_id presence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validLogEntryArb, { minLength: 1, maxLength: 10 }),
        fc.array(invalidLogEntryArb, { minLength: 1, maxLength: 10 }),
        async (validEntries, invalidEntries) => {
          const allEntries = [...validEntries, ...invalidEntries];
          const batch: LogBatch = { tenant_id: 'tenant-1', entries: allEntries };
          const ack = await service.ingestLogs(batch, ctx);

          expect(ack.accepted_count).toBe(validEntries.length);
          expect(ack.rejected_count).toBe(invalidEntries.length);
          expect(ack.accepted_count + ack.rejected_count).toBe(allEntries.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 39: Telemetry PII Exclusion ────────────────────────────────────

describe('Property 39: Telemetry PII Exclusion', () => {
  let service: TelemetryIngestionService;
  let piiRedactor: TelemetryPIIRedactor;
  let ctx: RequestContext;

  beforeEach(() => {
    piiRedactor = new TelemetryPIIRedactor();
    const goldenSignalComputer = new GoldenSignalComputer(60_000);
    const sloMonitor = new SLOMonitor();
    service = new TelemetryIngestionService(piiRedactor, goldenSignalComputer, sloMonitor);
    ctx = createTestContext();
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY log entry body containing PII patterns (emails, phones, IPs, etc.),
   * the redacted output replaces all PII with [REDACTED] and the original PII
   * value does NOT appear in the redacted string.
   */
  it('redacts PII from log entry bodies before storage', async () => {
    await fc.assert(
      fc.asyncProperty(
        stringWithPIIArb,
        piiValueArb,
        logSeverityArb,
        serviceNameArb,
        validCorrelationIdArb,
        async (bodyWithPII, embeddedPII, severity, serviceName, correlationId) => {
          // Ensure the PII is actually in the body
          const body = `${bodyWithPII} also contains ${embeddedPII}`;

          const entry = {
            timestamp: new Date().toISOString(),
            severity,
            body,
            service_name: serviceName,
            correlation_id: correlationId,
            attributes: {} as Record<string, string>,
          };

          const { redacted } = piiRedactor.redactLogEntry(entry);

          // The original PII value should not appear in the redacted body
          expect(redacted.body).not.toContain(embeddedPII);
          // The redacted body should contain [REDACTED] placeholder
          expect(redacted.body).toContain('[REDACTED]');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY trace span with PII in its attributes, the redacted span
   * has all PII values replaced with [REDACTED].
   */
  it('redacts PII from trace span attributes before storage', async () => {
    await fc.assert(
      fc.asyncProperty(
        piiAttributesArb,
        serviceNameArb,
        validCorrelationIdArb,
        spanStatusArb,
        async (piiAttrs, serviceName, correlationId, status) => {
          const span = {
            span_id: 'span-test-001',
            trace_id: 'trace-test-001',
            operation_name: 'GET /api/test',
            service_name: serviceName,
            correlation_id: correlationId,
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            status,
            duration_ms: 50,
            attributes: piiAttrs,
          };

          const { redacted, piiFound } = piiRedactor.redactSpan(span);

          expect(piiFound).toBe(true);

          // No original PII value should remain in redacted attributes
          for (const [key, originalValue] of Object.entries(piiAttrs)) {
            expect(redacted.attributes[key]).not.toBe(originalValue);
            expect(redacted.attributes[key]).toContain('[REDACTED]');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY metric with PII in its attributes, the redacted metric
   * has all PII values replaced with [REDACTED].
   */
  it('redacts PII from metric attributes before storage', async () => {
    await fc.assert(
      fc.asyncProperty(
        piiAttributesArb,
        serviceNameArb,
        validCorrelationIdArb,
        async (piiAttrs, serviceName, correlationId) => {
          const metric = {
            name: 'test.metric',
            value: 42,
            timestamp: new Date().toISOString(),
            service_name: serviceName,
            correlation_id: correlationId,
            attributes: piiAttrs,
          };

          const { redacted, piiFound } = piiRedactor.redactMetric(metric);

          expect(piiFound).toBe(true);

          // No original PII value should remain in redacted attributes
          for (const [key, originalValue] of Object.entries(piiAttrs)) {
            expect(redacted.attributes[key]).not.toBe(originalValue);
            expect(redacted.attributes[key]).toContain('[REDACTED]');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY telemetry data ingested through the service that contains PII,
   * the service accepts the data (PII is redacted, not rejected) and the
   * accepted_count reflects successful ingestion after redaction.
   */
  it('ingests telemetry with PII after redaction (does not reject)', async () => {
    await fc.assert(
      fc.asyncProperty(
        stringWithPIIArb,
        logSeverityArb,
        serviceNameArb,
        validCorrelationIdArb,
        async (bodyWithPII, severity, serviceName, correlationId) => {
          const batch: LogBatch = {
            tenant_id: 'tenant-1',
            entries: [
              {
                timestamp: new Date().toISOString(),
                severity,
                body: bodyWithPII,
                service_name: serviceName,
                correlation_id: correlationId,
                attributes: {},
              },
            ],
          };

          const ack = await service.ingestLogs(batch, ctx);

          // PII-containing entries with valid correlation_id are accepted (redacted, not rejected)
          expect(ack.accepted_count).toBe(1);
          expect(ack.rejected_count).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY string that does NOT contain PII patterns, the redactor
   * returns the string unchanged (no false positives on safe content).
   */
  it('does not alter strings without PII patterns', async () => {
    await fc.assert(
      fc.asyncProperty(safeStringArb, (safeValue) => {
        const result = piiRedactor.redactString(safeValue);
        expect(result).toBe(safeValue);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY email address, the redactor replaces it with [REDACTED].
   */
  it('redacts all email addresses', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, (email) => {
        const input = `User email is ${email} in the system`;
        const result = piiRedactor.redactString(input);

        expect(result).not.toContain(email);
        expect(result).toContain('[REDACTED]');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY IP address, the redactor replaces it with [REDACTED].
   */
  it('redacts all IP addresses', async () => {
    await fc.assert(
      fc.asyncProperty(ipAddressArb, (ip) => {
        const input = `Connection from ${ip} established`;
        const result = piiRedactor.redactString(input);

        expect(result).not.toContain(ip);
        expect(result).toContain('[REDACTED]');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 17.5**
   *
   * For ANY phone number, the redactor replaces it with [REDACTED].
   */
  it('redacts all phone numbers', async () => {
    await fc.assert(
      fc.asyncProperty(phoneArb, (phone) => {
        const input = `Call user at ${phone} for support`;
        const result = piiRedactor.redactString(input);

        expect(result).not.toContain(phone);
        expect(result).toContain('[REDACTED]');
      }),
      { numRuns: 100 },
    );
  });
});
