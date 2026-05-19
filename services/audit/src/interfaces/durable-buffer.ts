/**
 * Durable Buffer interface.
 *
 * Defines the contract for durably buffering audit events when SIEM
 * forwarding fails. Events are retained until successfully forwarded
 * or until the buffer age triggers an alert.
 *
 * @see Requirement 21.6 - Buffer events durably on forwarding failure
 */

import type { AuditEvent } from '@may/types';

/**
 * A buffered entry wrapping an audit event with metadata.
 */
export interface BufferedEntry {
  /** Unique identifier for this buffer entry */
  readonly id: string;
  /** The buffered audit event */
  readonly event: AuditEvent;
  /** ISO 8601 timestamp when the event was buffered */
  readonly buffered_at: string;
  /** Number of forwarding attempts made for this entry */
  readonly attempt_count: number;
  /** ISO 8601 timestamp of the last forwarding attempt (null if never attempted) */
  readonly last_attempt_at: string | null;
}

/**
 * Interface for durable event buffering.
 *
 * Implementations must guarantee that buffered events survive process
 * restarts (durable). The in-memory implementation is suitable for
 * testing only.
 */
export interface IDurableBuffer {
  /**
   * Adds events to the buffer for a given tenant.
   *
   * @param tenantId - The tenant identifier
   * @param events - The audit events to buffer
   */
  enqueue(tenantId: string, events: readonly AuditEvent[]): Promise<void>;

  /**
   * Retrieves the oldest buffered events for a tenant, up to the specified limit.
   * Does NOT remove them from the buffer (use `remove` after successful forwarding).
   *
   * @param tenantId - The tenant identifier
   * @param limit - Maximum number of entries to retrieve
   * @returns The oldest buffered entries
   */
  peek(tenantId: string, limit: number): Promise<readonly BufferedEntry[]>;

  /**
   * Removes successfully forwarded entries from the buffer.
   *
   * @param tenantId - The tenant identifier
   * @param entryIds - The IDs of entries to remove
   */
  remove(tenantId: string, entryIds: readonly string[]): Promise<void>;

  /**
   * Increments the attempt count and updates last_attempt_at for entries.
   *
   * @param tenantId - The tenant identifier
   * @param entryIds - The IDs of entries to mark as attempted
   */
  markAttempted(tenantId: string, entryIds: readonly string[]): Promise<void>;

  /**
   * Returns the age in milliseconds of the oldest buffered entry for a tenant.
   * Returns 0 if the buffer is empty.
   *
   * @param tenantId - The tenant identifier
   * @returns Age of the oldest entry in milliseconds
   */
  oldestEntryAge(tenantId: string): Promise<number>;

  /**
   * Returns the total number of buffered entries for a tenant.
   *
   * @param tenantId - The tenant identifier
   * @returns Count of buffered entries
   */
  size(tenantId: string): Promise<number>;
}
