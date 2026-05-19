/**
 * @module errors
 * PlatformError interface and error taxonomy.
 *
 * Provides a structured, machine-readable error model for all Platform services.
 * The error taxonomy categorizes errors by domain to enable consistent handling,
 * monitoring, and alerting across the distributed system.
 */

import type { CorrelationId, TenantId } from './branded.js';

/**
 * Error category taxonomy for the Platform.
 *
 * Each category maps to a domain of failure, enabling consistent
 * error handling, monitoring dashboards, and alerting rules.
 */
export type PlatformErrorCategory =
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'TIMEOUT'
  | 'SERVICE_UNAVAILABLE'
  | 'CIRCUIT_OPEN'
  | 'INTERNAL'
  | 'UPSTREAM_FAILURE'
  | 'DATA_RESIDENCY_VIOLATION'
  | 'CONSENT_REQUIRED'
  | 'UNSUPPORTED_OPERATION'
  | 'RESOURCE_EXHAUSTED'
  | 'POLICY_VIOLATION';

/**
 * Severity level for platform errors.
 * Aligns with audit event severity for consistent observability.
 */
export type ErrorSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Structured error interface for all Platform services.
 *
 * @remarks
 * - Every error carries a correlation_id for distributed trace linkage.
 * - The category enables automated routing to appropriate handlers.
 * - retryable indicates whether the caller should attempt the operation again.
 * - retry_after_ms provides a suggested backoff when retryable is true.
 */
export interface PlatformError {
  /** Machine-readable error code unique within the category (e.g., "INVALID_RISK_LEVEL"). */
  readonly code: string;

  /** Error domain category from the platform taxonomy. */
  readonly category: PlatformErrorCategory;

  /** Severity level for alerting and audit purposes. */
  readonly severity: ErrorSeverity;

  /** Human-readable error message. Should not contain PII. */
  readonly message: string;

  /** Correlation identifier linking this error to the originating request trace. */
  readonly correlation_id: CorrelationId;

  /** Tenant context in which the error occurred. */
  readonly tenant_id?: TenantId;

  /** The service that generated this error. */
  readonly source_service: string;

  /** Whether the caller should retry the operation. */
  readonly retryable: boolean;

  /** Suggested retry delay in milliseconds when retryable is true. */
  readonly retry_after_ms?: number;

  /** Additional structured details for debugging (must not contain PII). */
  readonly details?: Readonly<Record<string, unknown>>;

  /** ISO 8601 timestamp when the error occurred. */
  readonly timestamp: string;
}
