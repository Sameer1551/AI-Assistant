/**
 * SIEM Forwarder interface.
 *
 * Defines the contract for forwarding audit events to a tenant-configured
 * SIEM (Security Information and Event Management) destination.
 *
 * @see Requirement 21.5 - Forward events to SIEM within 60s at p95
 * @see Requirement 21.6 - Durable buffering on failure with backoff retry
 */

import type { AuditEvent } from '@may/types';

/**
 * Configuration for a tenant's SIEM destination.
 */
export interface SIEMEndpointConfig {
  /** Tenant identifier this config belongs to */
  readonly tenant_id: string;
  /** SIEM endpoint URL */
  readonly endpoint_url: string;
  /** Authentication token or API key for the SIEM */
  readonly auth_token: string;
  /** Optional custom headers for the SIEM endpoint */
  readonly headers?: Readonly<Record<string, string>>;
  /** Connection timeout in milliseconds (default: 10000) */
  readonly timeout_ms?: number;
}

/**
 * Result of a SIEM forwarding attempt.
 */
export interface ForwardResult {
  /** Whether the forwarding was successful */
  readonly success: boolean;
  /** HTTP status code if applicable */
  readonly status_code?: number;
  /** Error message on failure */
  readonly error?: string;
  /** Timestamp of the attempt */
  readonly attempted_at: string;
}

/**
 * Interface for forwarding audit events to a SIEM endpoint.
 *
 * Implementations handle the actual HTTP/transport-level communication
 * with the tenant's configured SIEM destination.
 */
export interface ISIEMForwarder {
  /**
   * Forwards a batch of audit events to the configured SIEM endpoint.
   *
   * @param events - The audit events to forward
   * @param config - The tenant's SIEM endpoint configuration
   * @returns Result indicating success or failure
   */
  forward(events: readonly AuditEvent[], config: SIEMEndpointConfig): Promise<ForwardResult>;
}
