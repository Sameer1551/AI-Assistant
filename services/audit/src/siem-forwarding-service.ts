/**
 * SIEM Forwarding Service implementation.
 *
 * Accepts audit events from the ingestion pipeline and forwards them to
 * tenant-configured SIEM endpoints. On failure, events are buffered durably
 * with exponential backoff retry. Emits a HIGH-severity alert if the oldest
 * buffered event exceeds 1 hour.
 *
 * @see Requirement 21.5 - Forward events to SIEM within 60s at p95
 * @see Requirement 21.6 - Durable buffering with backoff retry and alerting
 */

import type { AuditEvent } from '@may/types';
import type {
  ISIEMForwarder,
  SIEMEndpointConfig,
  IDurableBuffer,
} from './interfaces/index.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Configuration for the SIEM forwarding service.
 */
export interface SIEMForwardingConfig {
  /** Maximum number of events to forward in a single batch (default: 100) */
  readonly batch_size: number;
  /** Initial retry delay in milliseconds (default: 1000) */
  readonly initial_retry_delay_ms: number;
  /** Maximum retry delay in milliseconds (default: 60000) */
  readonly max_retry_delay_ms: number;
  /** Backoff multiplier (default: 2) */
  readonly backoff_multiplier: number;
  /** Buffer age threshold in milliseconds before emitting HIGH alert (default: 3600000 = 1 hour) */
  readonly buffer_age_alert_threshold_ms: number;
  /** Maximum number of retry attempts before giving up on a batch (default: 10) */
  readonly max_retry_attempts: number;
}

/**
 * Default SIEM forwarding configuration.
 */
export const DEFAULT_SIEM_FORWARDING_CONFIG: Readonly<SIEMForwardingConfig> = {
  batch_size: 100,
  initial_retry_delay_ms: 1000,
  max_retry_delay_ms: 60_000,
  backoff_multiplier: 2,
  buffer_age_alert_threshold_ms: 3_600_000, // 1 hour
  max_retry_attempts: 10,
};

// ─── Alert Emitter Interface ─────────────────────────────────────────────────

/**
 * Alert severity levels.
 */
export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * An alert emitted by the SIEM forwarding service.
 */
export interface SIEMAlert {
  /** Alert severity */
  readonly severity: AlertSeverity;
  /** Tenant affected */
  readonly tenant_id: string;
  /** Human-readable alert message */
  readonly message: string;
  /** ISO 8601 timestamp of the alert */
  readonly timestamp: string;
  /** Age of the oldest buffered event in milliseconds */
  readonly buffer_age_ms: number;
  /** Number of events currently buffered */
  readonly buffered_count: number;
}

/**
 * Interface for emitting alerts when buffer age exceeds threshold.
 */
export interface IAlertEmitter {
  /**
   * Emits an alert.
   *
   * @param alert - The alert to emit
   */
  emit(alert: SIEMAlert): Promise<void>;
}

// ─── SIEM Endpoint Config Provider ──────────────────────────────────────────

/**
 * Interface for retrieving tenant SIEM endpoint configurations.
 */
export interface ISIEMConfigProvider {
  /**
   * Retrieves the SIEM endpoint configuration for a tenant.
   * Returns null if the tenant has no SIEM configured.
   *
   * @param tenantId - The tenant identifier
   * @returns The SIEM endpoint config or null
   */
  getConfig(tenantId: string): Promise<SIEMEndpointConfig | null>;
}

// ─── Service Implementation ─────────────────────────────────────────────────


/**
 * Tracks per-tenant retry state for exponential backoff.
 */
interface RetryState {
  /** Current retry attempt count */
  attempt_count: number;
  /** Next scheduled retry time (epoch ms) */
  next_retry_at: number;
}

/**
 * SIEM Forwarding Service.
 *
 * Responsibilities:
 * - Accepts events from the audit ingestion pipeline
 * - Forwards to tenant-configured SIEM endpoint
 * - On failure: buffers durably with exponential backoff retry
 * - Tracks buffer age; emits HIGH alert if oldest buffered event > 1 hour
 *
 * Uses constructor injection for all dependencies:
 * - ISIEMForwarder: transport-level SIEM communication
 * - IDurableBuffer: durable event buffering
 * - ISIEMConfigProvider: tenant SIEM configuration lookup
 * - IAlertEmitter: alert emission
 */
export class SIEMForwardingService {
  private readonly config: SIEMForwardingConfig;
  private readonly retryStates: Map<string, RetryState> = new Map();

  /** Allows injecting a custom clock for testing. */
  private readonly now: () => number;

  constructor(
    private readonly forwarder: ISIEMForwarder,
    private readonly buffer: IDurableBuffer,
    private readonly configProvider: ISIEMConfigProvider,
    private readonly alertEmitter: IAlertEmitter,
    config?: Partial<SIEMForwardingConfig>,
    clock?: () => number,
  ) {
    this.config = { ...DEFAULT_SIEM_FORWARDING_CONFIG, ...config };
    this.now = clock ?? (() => Date.now());
  }

  /**
   * Forwards audit events to the tenant's configured SIEM.
   * On success, events are delivered directly.
   * On failure, events are buffered for retry.
   *
   * @param tenantId - The tenant identifier
   * @param events - The audit events to forward
   */
  async forwardEvents(tenantId: string, events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    const siemConfig = await this.configProvider.getConfig(tenantId);
    if (!siemConfig) {
      // No SIEM configured for this tenant; silently skip
      return;
    }

    const result = await this.forwarder.forward(events, siemConfig);

    if (result.success) {
      // Reset retry state on success
      this.retryStates.delete(tenantId);
    } else {
      // Buffer events for retry
      await this.buffer.enqueue(tenantId, events);
      this.initRetryState(tenantId);
    }
  }

  /**
   * Processes the retry buffer for a tenant.
   * Should be called periodically (e.g., by a scheduler/timer).
   *
   * Retrieves buffered events, checks if retry delay has elapsed,
   * attempts forwarding, and removes successfully forwarded entries.
   * Emits a HIGH alert if buffer age exceeds the configured threshold.
   *
   * @param tenantId - The tenant identifier
   * @returns True if all buffered events were successfully forwarded
   */
  async processRetryBuffer(tenantId: string): Promise<boolean> {
    const bufferSize = await this.buffer.size(tenantId);
    if (bufferSize === 0) {
      this.retryStates.delete(tenantId);
      return true;
    }

    // Check buffer age and emit alert if threshold exceeded
    await this.checkBufferAge(tenantId);

    // Check if we should retry yet (respect backoff delay)
    const retryState = this.retryStates.get(tenantId);
    if (retryState && this.now() < retryState.next_retry_at) {
      return false;
    }

    const siemConfig = await this.configProvider.getConfig(tenantId);
    if (!siemConfig) {
      return false;
    }

    // Peek at buffered events
    const entries = await this.buffer.peek(tenantId, this.config.batch_size);
    if (entries.length === 0) {
      return true;
    }

    const events = entries.map((e) => e.event);
    const entryIds = entries.map((e) => e.id);

    // Mark as attempted
    await this.buffer.markAttempted(tenantId, entryIds);

    // Attempt forwarding
    const result = await this.forwarder.forward(events, siemConfig);

    if (result.success) {
      // Remove successfully forwarded entries
      await this.buffer.remove(tenantId, entryIds);
      // Reset retry state if buffer is now empty
      const remaining = await this.buffer.size(tenantId);
      if (remaining === 0) {
        this.retryStates.delete(tenantId);
      }
      return remaining === 0;
    } else {
      // Advance backoff
      this.advanceRetryState(tenantId);
      return false;
    }
  }

  /**
   * Computes the retry delay for a given attempt count using exponential backoff.
   *
   * delay = min(initial_retry_delay_ms * backoff_multiplier^(attempt - 1), max_retry_delay_ms)
   *
   * @param attemptCount - The current attempt number (1-based)
   * @returns The delay in milliseconds
   */
  computeRetryDelay(attemptCount: number): number {
    const delay =
      this.config.initial_retry_delay_ms *
      Math.pow(this.config.backoff_multiplier, attemptCount - 1);
    return Math.min(delay, this.config.max_retry_delay_ms);
  }

  /**
   * Returns the current retry state for a tenant (for testing/observability).
   *
   * @param tenantId - The tenant identifier
   * @returns The retry state or undefined if no retry is pending
   */
  getRetryState(tenantId: string): Readonly<RetryState> | undefined {
    return this.retryStates.get(tenantId);
  }

  /**
   * Checks buffer age and emits a HIGH alert if the oldest entry exceeds the threshold.
   */
  private async checkBufferAge(tenantId: string): Promise<void> {
    const age = await this.buffer.oldestEntryAge(tenantId);
    if (age >= this.config.buffer_age_alert_threshold_ms) {
      const bufferedCount = await this.buffer.size(tenantId);
      await this.alertEmitter.emit({
        severity: 'HIGH',
        tenant_id: tenantId,
        message: `SIEM forwarding buffer age exceeds threshold. Oldest event buffered ${Math.round(age / 60_000)} minutes ago.`,
        timestamp: new Date(this.now()).toISOString(),
        buffer_age_ms: age,
        buffered_count: bufferedCount,
      });
    }
  }

  /**
   * Initializes retry state for a tenant if not already present.
   */
  private initRetryState(tenantId: string): void {
    if (!this.retryStates.has(tenantId)) {
      const delay = this.computeRetryDelay(1);
      this.retryStates.set(tenantId, {
        attempt_count: 1,
        next_retry_at: this.now() + delay,
      });
    }
  }

  /**
   * Advances the retry state with exponential backoff.
   */
  private advanceRetryState(tenantId: string): void {
    const current = this.retryStates.get(tenantId);
    const nextAttempt = current ? current.attempt_count + 1 : 1;
    const delay = this.computeRetryDelay(nextAttempt);
    this.retryStates.set(tenantId, {
      attempt_count: nextAttempt,
      next_retry_at: this.now() + delay,
    });
  }
}
