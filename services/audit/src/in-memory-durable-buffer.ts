/**
 * In-memory implementation of IDurableBuffer.
 *
 * Suitable for testing only. Production implementations should use
 * persistent storage (e.g., SQLite, filesystem, or a message queue)
 * to survive process restarts.
 *
 * @see Requirement 21.6 - Durable buffering on SIEM forwarding failure
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@may/types';
import type { IDurableBuffer, BufferedEntry } from './interfaces/durable-buffer.js';

/**
 * Mutable internal representation of a buffered entry.
 */
interface MutableBufferedEntry {
  readonly id: string;
  readonly event: AuditEvent;
  readonly buffered_at: string;
  attempt_count: number;
  last_attempt_at: string | null;
}

/**
 * In-memory durable buffer for testing.
 *
 * Stores buffered events in a Map keyed by tenant_id.
 * Entries are ordered by insertion time (oldest first).
 */
export class InMemoryDurableBuffer implements IDurableBuffer {
  private readonly buffers: Map<string, MutableBufferedEntry[]> = new Map();

  /** Allows injecting a custom clock for testing. */
  private readonly now: () => string;

  constructor(clock?: () => string) {
    this.now = clock ?? (() => new Date().toISOString());
  }

  async enqueue(tenantId: string, events: readonly AuditEvent[]): Promise<void> {
    const buffer = this.getOrCreateBuffer(tenantId);
    for (const event of events) {
      buffer.push({
        id: randomUUID(),
        event,
        buffered_at: this.now(),
        attempt_count: 0,
        last_attempt_at: null,
      });
    }
  }

  async peek(tenantId: string, limit: number): Promise<readonly BufferedEntry[]> {
    const buffer = this.buffers.get(tenantId);
    if (!buffer || buffer.length === 0) {
      return [];
    }
    return buffer.slice(0, limit).map((entry) => ({ ...entry }));
  }

  async remove(tenantId: string, entryIds: readonly string[]): Promise<void> {
    const buffer = this.buffers.get(tenantId);
    if (!buffer) return;

    const idsToRemove = new Set(entryIds);
    const remaining = buffer.filter((entry) => !idsToRemove.has(entry.id));
    this.buffers.set(tenantId, remaining);
  }

  async markAttempted(tenantId: string, entryIds: readonly string[]): Promise<void> {
    const buffer = this.buffers.get(tenantId);
    if (!buffer) return;

    const idsToMark = new Set(entryIds);
    const now = this.now();
    for (const entry of buffer) {
      if (idsToMark.has(entry.id)) {
        entry.attempt_count += 1;
        entry.last_attempt_at = now;
      }
    }
  }

  async oldestEntryAge(tenantId: string): Promise<number> {
    const buffer = this.buffers.get(tenantId);
    if (!buffer || buffer.length === 0) {
      return 0;
    }
    const oldest = buffer[0]!;
    const bufferedAt = new Date(oldest.buffered_at).getTime();
    const now = new Date(this.now()).getTime();
    return Math.max(0, now - bufferedAt);
  }

  async size(tenantId: string): Promise<number> {
    const buffer = this.buffers.get(tenantId);
    return buffer?.length ?? 0;
  }

  private getOrCreateBuffer(tenantId: string): MutableBufferedEntry[] {
    let buffer = this.buffers.get(tenantId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(tenantId, buffer);
    }
    return buffer;
  }
}
