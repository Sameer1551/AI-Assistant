/**
 * Unit tests for TelemetryPIIRedactor.
 *
 * Verifies:
 * - Email addresses are redacted from telemetry data
 * - Phone numbers are redacted
 * - IP addresses are redacted
 * - Payment card numbers are redacted
 * - Credentials/tokens are redacted
 * - Clean data passes through unchanged
 * - All telemetry signal types (metrics, spans, logs) are handled
 *
 * @see Requirement 17.5 - PII exclusion from telemetry
 */

import { describe, it, expect } from 'vitest';
import { TelemetryPIIRedactor } from '../src/telemetry-pii-redactor.js';
import type { MetricDataPoint, TraceSpan, LogEntry } from '../src/interfaces/index.js';

const redactor = new TelemetryPIIRedactor();

function createMetric(overrides: Partial<MetricDataPoint> = {}): MetricDataPoint {
  return {
    name: 'http.server.request.duration',
    value: 42.5,
    timestamp: '2024-01-15T10:30:00.000Z',
    service_name: 'LLM_Gateway',
    correlation_id: 'corr-123',
    attributes: {},
    ...overrides,
  };
}

function createSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    span_id: 'span-001',
    trace_id: 'trace-001',
    operation_name: 'GET /api/users',
    service_name: 'Identity_Service',
    correlation_id: 'corr-123',
    start_time: '2024-01-15T10:30:00.000Z',
    end_time: '2024-01-15T10:30:00.050Z',
    status: 'ok',
    duration_ms: 50,
    attributes: {},
    ...overrides,
  };
}

function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2024-01-15T10:30:00.000Z',
    severity: 'INFO',
    body: 'Request processed successfully',
    service_name: 'Control_Service',
    correlation_id: 'corr-123',
    attributes: {},
    ...overrides,
  };
}

describe('TelemetryPIIRedactor', () => {
  describe('redactString', () => {
    it('should redact email addresses', () => {
      const result = redactor.redactString('User john.doe@example.com logged in');
      expect(result).not.toContain('john.doe@example.com');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact phone numbers', () => {
      const result = redactor.redactString('Contact: +1-555-123-4567');
      expect(result).not.toContain('555-123-4567');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact IP addresses', () => {
      const result = redactor.redactString('Request from 192.168.1.100');
      expect(result).not.toContain('192.168.1.100');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact payment card numbers', () => {
      const result = redactor.redactString('Card: 4111-1111-1111-1111');
      expect(result).not.toContain('4111-1111-1111-1111');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact SSN-like government IDs', () => {
      const result = redactor.redactString('SSN: 123-45-6789');
      expect(result).not.toContain('123-45-6789');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact credentials (api_key=value)', () => {
      const result = redactor.redactString('Using api_key=sk_live_abc123xyz');
      expect(result).not.toContain('sk_live_abc123xyz');
      expect(result).toContain('[REDACTED]');
    });

    it('should redact Bearer tokens', () => {
      const result = redactor.redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(result).toContain('[REDACTED]');
    });

    it('should not modify clean strings', () => {
      const clean = 'Request completed in 42ms with status 200';
      const result = redactor.redactString(clean);
      expect(result).toBe(clean);
    });

    it('should handle empty strings', () => {
      expect(redactor.redactString('')).toBe('');
    });
  });

  describe('redactMetric', () => {
    it('should redact PII from metric attributes', () => {
      const metric = createMetric({
        attributes: { user_email: 'alice@corp.com', endpoint: '/api/health' },
      });

      const { redacted, piiFound } = redactor.redactMetric(metric);

      expect(piiFound).toBe(true);
      expect(redacted.attributes['user_email']).not.toContain('alice@corp.com');
      expect(redacted.attributes['endpoint']).toBe('/api/health');
    });

    it('should not flag clean metrics', () => {
      const metric = createMetric({
        attributes: { method: 'GET', path: '/api/health' },
      });

      const { redacted, piiFound } = redactor.redactMetric(metric);

      expect(piiFound).toBe(false);
      expect(redacted.attributes).toEqual(metric.attributes);
    });

    it('should preserve non-attribute fields', () => {
      const metric = createMetric({ value: 99.9 });
      const { redacted } = redactor.redactMetric(metric);

      expect(redacted.name).toBe(metric.name);
      expect(redacted.value).toBe(99.9);
      expect(redacted.service_name).toBe(metric.service_name);
    });
  });

  describe('redactSpan', () => {
    it('should redact PII from span attributes', () => {
      const span = createSpan({
        attributes: { 'http.url': 'https://api.example.com/users?email=bob@test.com' },
      });

      const { redacted, piiFound } = redactor.redactSpan(span);

      expect(piiFound).toBe(true);
      expect(redacted.attributes['http.url']).not.toContain('bob@test.com');
    });

    it('should redact PII from operation name', () => {
      const span = createSpan({
        operation_name: 'GET /users/john.doe@example.com/profile',
      });

      const { redacted, piiFound } = redactor.redactSpan(span);

      expect(piiFound).toBe(true);
      expect(redacted.operation_name).not.toContain('john.doe@example.com');
    });

    it('should not flag clean spans', () => {
      const span = createSpan();
      const { piiFound } = redactor.redactSpan(span);
      expect(piiFound).toBe(false);
    });
  });

  describe('redactLogEntry', () => {
    it('should redact PII from log body', () => {
      const entry = createLogEntry({
        body: 'Failed login for user alice@company.org from 10.0.0.1',
      });

      const { redacted, piiFound } = redactor.redactLogEntry(entry);

      expect(piiFound).toBe(true);
      expect(redacted.body).not.toContain('alice@company.org');
      expect(redacted.body).not.toContain('10.0.0.1');
    });

    it('should redact PII from log attributes', () => {
      const entry = createLogEntry({
        attributes: { caller_ip: '172.16.0.50' },
      });

      const { redacted, piiFound } = redactor.redactLogEntry(entry);

      expect(piiFound).toBe(true);
      expect(redacted.attributes['caller_ip']).not.toContain('172.16.0.50');
    });

    it('should not flag clean log entries', () => {
      const entry = createLogEntry();
      const { piiFound } = redactor.redactLogEntry(entry);
      expect(piiFound).toBe(false);
    });
  });

  describe('getProhibitedCategories', () => {
    it('should return all required PII categories', () => {
      const categories = redactor.getProhibitedCategories();

      expect(categories).toContain('email');
      expect(categories).toContain('phone');
      expect(categories).toContain('ip_address');
      expect(categories).toContain('payment_card');
      expect(categories).toContain('government_id');
      expect(categories).toContain('credential');
      expect(categories).toContain('name');
      expect(categories).toContain('address');
      expect(categories).toContain('geolocation');
      expect(categories).toContain('date_of_birth');
      expect(categories).toContain('bank_account');
    });
  });
});
