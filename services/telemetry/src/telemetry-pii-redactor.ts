/**
 * @module telemetry-pii-redactor
 * TelemetryPIIRedactor — strips PII from telemetry data before storage.
 *
 * Implements a documented redaction pipeline that detects and removes
 * prohibited PII categories from metrics attributes, trace spans, and log entries.
 *
 * @see Requirement 17.5 - PII exclusion from telemetry
 */

import type { PIICategory } from '@may/types';
import type {
  ITelemetryPIIRedactor,
  MetricDataPoint,
  TraceSpan,
  LogEntry,
} from './interfaces/index.js';

/** Redaction placeholder used to replace PII values. */
const REDACTED = '[REDACTED]';

/**
 * Pattern definitions for PII detection.
 * Each pattern maps a PIICategory to one or more regex patterns.
 */
const PII_PATTERNS: ReadonlyMap<PIICategory, readonly RegExp[]> = new Map([
  ['email', [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g]],
  ['phone', [/\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g]],
  ['ip_address', [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g]],
  ['payment_card', [/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g]],
  ['government_id', [
    // SSN pattern
    /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  ]],
  ['credential', [
    // Bearer tokens, API keys, passwords in key=value
    /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g,
    /\b(api[_-]?key|password|secret|token)\s*[=:]\s*\S+/gi,
  ]],
  ['geolocation', [
    // Lat/long coordinates
    /[-+]?\d{1,3}\.\d{4,},\s*[-+]?\d{1,3}\.\d{4,}/g,
  ]],
  ['date_of_birth', [
    // Common date formats that could be DOB
    /\b(0[1-9]|1[0-2])[/\-](0[1-9]|[12]\d|3[01])[/\-](19|20)\d{2}\b/g,
  ]],
]);

/**
 * All PII categories that are prohibited in telemetry data.
 */
const PROHIBITED_CATEGORIES: readonly PIICategory[] = [
  'name',
  'address',
  'phone',
  'email',
  'government_id',
  'payment_card',
  'bank_account',
  'ip_address',
  'geolocation',
  'date_of_birth',
  'credential',
];

/**
 * TelemetryPIIRedactor implementation.
 * Scans telemetry data for PII patterns and replaces them with redaction placeholders.
 */
export class TelemetryPIIRedactor implements ITelemetryPIIRedactor {
  redactMetric(metric: MetricDataPoint): { redacted: MetricDataPoint; piiFound: boolean } {
    let piiFound = false;
    const redactedAttributes: Record<string, string> = {};

    for (const [key, value] of Object.entries(metric.attributes)) {
      const redactedValue = this.redactString(value);
      if (redactedValue !== value) {
        piiFound = true;
      }
      redactedAttributes[key] = redactedValue;
    }

    const redacted: MetricDataPoint = {
      ...metric,
      attributes: redactedAttributes,
    };

    return { redacted, piiFound };
  }

  redactSpan(span: TraceSpan): { redacted: TraceSpan; piiFound: boolean } {
    let piiFound = false;
    const redactedAttributes: Record<string, string> = {};

    for (const [key, value] of Object.entries(span.attributes)) {
      const redactedValue = this.redactString(value);
      if (redactedValue !== value) {
        piiFound = true;
      }
      redactedAttributes[key] = redactedValue;
    }

    const redactedOperationName = this.redactString(span.operation_name);
    if (redactedOperationName !== span.operation_name) {
      piiFound = true;
    }

    const redacted: TraceSpan = {
      ...span,
      operation_name: redactedOperationName,
      attributes: redactedAttributes,
    };

    return { redacted, piiFound };
  }

  redactLogEntry(entry: LogEntry): { redacted: LogEntry; piiFound: boolean } {
    let piiFound = false;
    const redactedAttributes: Record<string, string> = {};

    for (const [key, value] of Object.entries(entry.attributes)) {
      const redactedValue = this.redactString(value);
      if (redactedValue !== value) {
        piiFound = true;
      }
      redactedAttributes[key] = redactedValue;
    }

    const redactedBody = this.redactString(entry.body);
    if (redactedBody !== entry.body) {
      piiFound = true;
    }

    const redacted: LogEntry = {
      ...entry,
      body: redactedBody,
      attributes: redactedAttributes,
    };

    return { redacted, piiFound };
  }

  redactString(value: string): string {
    let result = value;

    for (const [, patterns] of PII_PATTERNS) {
      for (const pattern of patterns) {
        // Reset lastIndex for global regex
        const regex = new RegExp(pattern.source, pattern.flags);
        result = result.replace(regex, REDACTED);
      }
    }

    return result;
  }

  getProhibitedCategories(): readonly PIICategory[] {
    return PROHIBITED_CATEGORIES;
  }
}
