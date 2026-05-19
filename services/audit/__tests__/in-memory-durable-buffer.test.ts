/**
 * Unit tests for InMemoryDurableBuffer.
 *
 * Verifies the durable buffer contract:
 * - Enqueue and peek operations
 * - Entry removal after successful forwarding
 * - Attempt tracking
 * - Oldest entry age calculation
 * - Tenant isolation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AuditEvent } from '@may/types';
import { InMemoryDurableBuffer } from '../src/in-memory-durable-buffer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: 'evt-001',
    sequence_number: 1,
    chain_hash: 'abc123',
    timestamp: '2024-01-15T10:30:00.000Z',
    tenant_id: 'tenant-1',
    principal_id: 'principal-1',
    source_service: 'Control_Service',
    event_category: 'action.executed',
    severity: 'INFO',
    correlation_id: 'corr-123',
    outcome: 'SUCCESS',
    payload: { action_id: 'act-1' },
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('InMemoryDurableBuffer', () => {
  let currentTime: string;
  let buffer: InMemoryDurableBuffer;

  beforeEach(() => {
    currentTime = '2024-01-15T10:30:00.000Z';
    buffer = new InMemoryDurableBuffer(() => currentTime);
  });

  describe('enqueue', () => {
    it('should add events to the buffer', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const size = await buffer.size('tenant-1');
      expect(size).toBe(1);
    });

    it('should add multiple events at once', async () => {
      const events = [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
        createTestEvent({ event_id: 'evt-003' }),
      ];
      await buffer.enqueue('tenant-1', events);
      const size = await buffer.size('tenant-1');
      expect(size).toBe(3);
    });

    it('should accumulate events across multiple enqueue calls', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-001' })]);
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-002' })]);
      const size = await buffer.size('tenant-1');
      expect(size).toBe(2);
    });

    it('should assign unique IDs to each entry', async () => {
      await buffer.enqueue('tenant-1', [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
      ]);
      const entries = await buffer.peek('tenant-1', 10);
      expect(entries[0]!.id).not.toBe(entries[1]!.id);
    });

    it('should record buffered_at timestamp', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const entries = await buffer.peek('tenant-1', 10);
      expect(entries[0]!.buffered_at).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should initialize attempt_count to 0', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const entries = await buffer.peek('tenant-1', 10);
      expect(entries[0]!.attempt_count).toBe(0);
    });

    it('should initialize last_attempt_at to null', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const entries = await buffer.peek('tenant-1', 10);
      expect(entries[0]!.last_attempt_at).toBeNull();
    });
  });

  describe('peek', () => {
    it('should return empty array for empty buffer', async () => {
      const entries = await buffer.peek('tenant-1', 10);
      expect(entries).toEqual([]);
    });

    it('should return oldest entries first', async () => {
      currentTime = '2024-01-15T10:30:00.000Z';
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-001' })]);
      currentTime = '2024-01-15T10:31:00.000Z';
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-002' })]);

      const entries = await buffer.peek('tenant-1', 10);
      expect(entries[0]!.event.event_id).toBe('evt-001');
      expect(entries[1]!.event.event_id).toBe('evt-002');
    });

    it('should respect the limit parameter', async () => {
      await buffer.enqueue('tenant-1', [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
        createTestEvent({ event_id: 'evt-003' }),
      ]);

      const entries = await buffer.peek('tenant-1', 2);
      expect(entries).toHaveLength(2);
    });

    it('should not remove entries from the buffer', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      await buffer.peek('tenant-1', 10);
      const size = await buffer.size('tenant-1');
      expect(size).toBe(1);
    });
  });

  describe('remove', () => {
    it('should remove specified entries by ID', async () => {
      await buffer.enqueue('tenant-1', [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
      ]);

      const entries = await buffer.peek('tenant-1', 10);
      await buffer.remove('tenant-1', [entries[0]!.id]);

      const remaining = await buffer.peek('tenant-1', 10);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.event.event_id).toBe('evt-002');
    });

    it('should handle removing non-existent IDs gracefully', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      await buffer.remove('tenant-1', ['non-existent-id']);
      const size = await buffer.size('tenant-1');
      expect(size).toBe(1);
    });

    it('should handle removing from non-existent tenant gracefully', async () => {
      await buffer.remove('non-existent-tenant', ['some-id']);
      // Should not throw
    });
  });

  describe('markAttempted', () => {
    it('should increment attempt_count', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const entries = await buffer.peek('tenant-1', 10);

      await buffer.markAttempted('tenant-1', [entries[0]!.id]);

      const updated = await buffer.peek('tenant-1', 10);
      expect(updated[0]!.attempt_count).toBe(1);
    });

    it('should update last_attempt_at', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const entries = await buffer.peek('tenant-1', 10);

      currentTime = '2024-01-15T11:00:00.000Z';
      await buffer.markAttempted('tenant-1', [entries[0]!.id]);

      const updated = await buffer.peek('tenant-1', 10);
      expect(updated[0]!.last_attempt_at).toBe('2024-01-15T11:00:00.000Z');
    });

    it('should increment attempt_count on multiple marks', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      const entries = await buffer.peek('tenant-1', 10);

      await buffer.markAttempted('tenant-1', [entries[0]!.id]);
      await buffer.markAttempted('tenant-1', [entries[0]!.id]);
      await buffer.markAttempted('tenant-1', [entries[0]!.id]);

      const updated = await buffer.peek('tenant-1', 10);
      expect(updated[0]!.attempt_count).toBe(3);
    });
  });

  describe('oldestEntryAge', () => {
    it('should return 0 for empty buffer', async () => {
      const age = await buffer.oldestEntryAge('tenant-1');
      expect(age).toBe(0);
    });

    it('should return correct age in milliseconds', async () => {
      currentTime = '2024-01-15T10:00:00.000Z';
      await buffer.enqueue('tenant-1', [createTestEvent()]);

      // Advance time by 30 minutes
      currentTime = '2024-01-15T10:30:00.000Z';
      const age = await buffer.oldestEntryAge('tenant-1');
      expect(age).toBe(30 * 60 * 1000); // 30 minutes in ms
    });

    it('should return age of the oldest entry when multiple exist', async () => {
      currentTime = '2024-01-15T10:00:00.000Z';
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-001' })]);

      currentTime = '2024-01-15T10:15:00.000Z';
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-002' })]);

      currentTime = '2024-01-15T10:30:00.000Z';
      const age = await buffer.oldestEntryAge('tenant-1');
      // Oldest entry was buffered at 10:00, current time is 10:30 = 30 minutes
      expect(age).toBe(30 * 60 * 1000);
    });
  });

  describe('size', () => {
    it('should return 0 for empty buffer', async () => {
      const size = await buffer.size('tenant-1');
      expect(size).toBe(0);
    });

    it('should return 0 for non-existent tenant', async () => {
      const size = await buffer.size('non-existent');
      expect(size).toBe(0);
    });

    it('should return correct count after enqueue', async () => {
      await buffer.enqueue('tenant-1', [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
      ]);
      const size = await buffer.size('tenant-1');
      expect(size).toBe(2);
    });

    it('should return correct count after removal', async () => {
      await buffer.enqueue('tenant-1', [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
      ]);
      const entries = await buffer.peek('tenant-1', 10);
      await buffer.remove('tenant-1', [entries[0]!.id]);

      const size = await buffer.size('tenant-1');
      expect(size).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it('should maintain separate buffers per tenant', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent()]);
      await buffer.enqueue('tenant-2', [
        createTestEvent({ event_id: 'evt-t2-1' }),
        createTestEvent({ event_id: 'evt-t2-2' }),
      ]);

      expect(await buffer.size('tenant-1')).toBe(1);
      expect(await buffer.size('tenant-2')).toBe(2);
    });

    it('should not leak entries between tenants on peek', async () => {
      await buffer.enqueue('tenant-1', [createTestEvent({ event_id: 'evt-t1' })]);
      await buffer.enqueue('tenant-2', [createTestEvent({ event_id: 'evt-t2' })]);

      const entries1 = await buffer.peek('tenant-1', 10);
      const entries2 = await buffer.peek('tenant-2', 10);

      expect(entries1).toHaveLength(1);
      expect(entries1[0]!.event.event_id).toBe('evt-t1');
      expect(entries2).toHaveLength(1);
      expect(entries2[0]!.event.event_id).toBe('evt-t2');
    });
  });
});
