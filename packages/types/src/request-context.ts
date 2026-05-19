/**
 * @module request-context
 * RequestContext — propagated on every inter-service request.
 *
 * Establishes the cryptographic tenant boundary, authenticated principal,
 * distributed trace correlation, and authorization attributes for each request.
 */

import type {
  TenantId,
  PrincipalId,
  CorrelationId,
  SessionId,
} from './branded.js';

/**
 * W3C Trace Context headers for distributed tracing.
 * @see https://www.w3.org/TR/trace-context/
 */
export interface W3CTraceContext {
  /** The traceparent header value (version-trace_id-parent_id-trace_flags) */
  readonly traceparent: string;
  /** Optional tracestate header value for vendor-specific trace data */
  readonly tracestate?: string;
}

/**
 * RequestContext is propagated on every inter-service request.
 *
 * It establishes the cryptographic tenant boundary, identifies the authenticated
 * principal, carries distributed trace correlation, and provides resolved
 * authorization attributes for RBAC/ABAC evaluation.
 *
 * @remarks
 * Every service MUST validate that the tenant_id in the RequestContext matches
 * the authenticated identity before processing any data operation.
 */
export interface RequestContext {
  /** UUID — cryptographic tenant boundary. All data access is scoped to this tenant. */
  readonly tenant_id: TenantId;

  /** UUID — authenticated user or service principal making the request. */
  readonly principal_id: PrincipalId;

  /** UUID — traces a single logical operation across all services. */
  readonly correlation_id: CorrelationId;

  /** W3C TraceContext for OpenTelemetry-compatible distributed tracing. */
  readonly trace_context: W3CTraceContext;

  /** UUID — current authenticated session. */
  readonly session_id: SessionId;

  /** Resolved RBAC roles for the principal in this tenant. */
  readonly roles: readonly string[];

  /** ABAC attributes for fine-grained authorization decisions. */
  readonly attributes: Readonly<Record<string, string>>;

  /** Tenant's configured data residency region. All processing must respect this. */
  readonly residency_region: string;
}
