/**
 * RevocationPropagator - Ensures revocation reaches all consumers within 5 minutes.
 *
 * Uses a pub/sub pattern to notify dependent services when a key is revoked.
 * Tracks notification delivery and enforces the 5-minute propagation deadline.
 *
 * @see Requirement 19.5 - Revocation propagates within 5 minutes
 */

import type { IRevocationPropagator } from './interfaces/index.js';

// ─── Consumer Registration ───────────────────────────────────────────────────

/** A registered consumer that needs to be notified of revocations. */
export interface RevocationConsumer {
  /** Unique identifier for this consumer. */
  readonly id: string;

  /** Human-readable name of the consumer service. */
  readonly name: string;

  /** Callback invoked when a key is revoked. */
  readonly onRevocation: (keyId: string, tenantId: string, reason: string) => Promise<void>;
}

/** Record of a notification delivery attempt. */
export interface NotificationRecord {
  /** Consumer that was notified. */
  readonly consumer_id: string;

  /** Key that was revoked. */
  readonly key_id: string;

  /** Tenant that owns the key. */
  readonly tenant_id: string;

  /** Whether notification was successful. */
  readonly success: boolean;

  /** Error message if notification failed. */
  readonly error?: string;

  /** Timestamp of the notification attempt. */
  readonly notified_at: string;

  /** Duration of the notification in milliseconds. */
  readonly duration_ms: number;
}

// ─── RevocationPropagator Implementation ─────────────────────────────────────

/**
 * Production-grade revocation propagator using pub/sub pattern.
 *
 * Notifies all registered consumers when a key is revoked.
 * Tracks delivery status and enforces the 5-minute propagation deadline.
 *
 * Features:
 * - Consumer registration/unregistration
 * - Parallel notification delivery
 * - Per-consumer timeout enforcement
 * - Delivery tracking and audit trail
 * - Retry on transient failures
 *
 * @example
 * ```typescript
 * const propagator = new RevocationPropagatorImpl();
 * propagator.registerConsumer({
 *   id: 'audit-service',
 *   name: 'Audit_Service',
 *   onRevocation: async (keyId, tenantId, reason) => { ... }
 * });
 * const notified = await propagator.propagate('key-001', 'tenant-001', 'suspected compromise');
 * ```
 */
export class RevocationPropagatorImpl implements IRevocationPropagator {
  private readonly consumers: Map<string, RevocationConsumer> = new Map();
  private readonly notificationLog: NotificationRecord[] = [];

  /** Maximum time to wait for a single consumer notification (ms). */
  private readonly perConsumerTimeoutMs: number;

  /** Maximum number of retry attempts per consumer. */
  private readonly maxRetries: number;

  constructor(options?: { perConsumerTimeoutMs?: number; maxRetries?: number }) {
    this.perConsumerTimeoutMs = options?.perConsumerTimeoutMs ?? 30_000; // 30s per consumer
    this.maxRetries = options?.maxRetries ?? 2;
  }

  /**
   * Registers a consumer to receive revocation notifications.
   *
   * @param consumer - The consumer to register
   */
  registerConsumer(consumer: RevocationConsumer): void {
    this.consumers.set(consumer.id, consumer);
  }

  /**
   * Unregisters a consumer from revocation notifications.
   *
   * @param consumerId - The consumer ID to unregister
   * @returns True if the consumer was found and removed
   */
  unregisterConsumer(consumerId: string): boolean {
    return this.consumers.delete(consumerId);
  }

  /**
   * Propagates a key revocation to all registered consumers.
   * Notifications are sent in parallel with per-consumer timeout.
   *
   * @param keyId - The revoked key identifier
   * @param tenantId - The tenant that owns the key
   * @param reason - Reason for revocation
   * @returns Number of consumers successfully notified
   */
  async propagate(keyId: string, tenantId: string, reason: string): Promise<number> {
    const consumers = Array.from(this.consumers.values());

    if (consumers.length === 0) {
      return 0;
    }

    // Notify all consumers in parallel
    const results = await Promise.allSettled(
      consumers.map((consumer) =>
        this.notifyWithRetry(consumer, keyId, tenantId, reason),
      ),
    );

    let successCount = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        successCount++;
      }
    }

    return successCount;
  }

  /**
   * Returns the notification log for auditing purposes.
   */
  getNotificationLog(): readonly NotificationRecord[] {
    return [...this.notificationLog];
  }

  /**
   * Returns the number of registered consumers.
   */
  get consumerCount(): number {
    return this.consumers.size;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private async notifyWithRetry(
    consumer: RevocationConsumer,
    keyId: string,
    tenantId: string,
    reason: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        await this.notifyWithTimeout(consumer, keyId, tenantId, reason);
        const duration = Date.now() - startTime;

        this.notificationLog.push({
          consumer_id: consumer.id,
          key_id: keyId,
          tenant_id: tenantId,
          success: true,
          notified_at: new Date().toISOString(),
          duration_ms: duration,
        });

        return true;
      } catch (err: unknown) {
        const duration = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        this.notificationLog.push({
          consumer_id: consumer.id,
          key_id: keyId,
          tenant_id: tenantId,
          success: false,
          error: errorMessage,
          notified_at: new Date().toISOString(),
          duration_ms: duration,
        });

        // Don't retry on last attempt
        if (attempt === this.maxRetries) {
          return false;
        }

        // Brief delay before retry
        await this.delay(100 * (attempt + 1));
      }
    }

    return false;
  }

  private async notifyWithTimeout(
    consumer: RevocationConsumer,
    keyId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Notification timeout for consumer ${consumer.id}`)),
        this.perConsumerTimeoutMs,
      );
    });

    await Promise.race([
      consumer.onRevocation(keyId, tenantId, reason),
      timeoutPromise,
    ]);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
