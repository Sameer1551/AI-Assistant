/**
 * Unit tests for InMemoryIdempotencyStore.
 *
 * Verifies:
 * - Storing and retrieving cached results
 * - 24-hour expiration window
 * - Eviction of expired entries
 * - Key existence checks
 *
 * @see Requirement 2.7 - Idempotency keys with 24h deduplication window
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ActionResponse } from '@may/types';
import type { ActionId, IdempotencyKey, CorrelationId } from '@may/types';
import { InMemoryIdempotencyStore } from '../src/in-memory-idempotency-store.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestResponse(overrides: Partial<ActionResponse> = {}): ActionResponse {
  return {
    action_id: 'action-1' as ActionId,
    idempotency_key: 'idem-key-1' as IdempotencyKey,
    outcome: 'SUCCESS',
    duration_ms: 150,
    audit_event_id: 'audit-event-1',
    correlation_id: 'corr-1' as CorrelationId,
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('InMemoryIdempotencyStore', () => {
  let currentTime: number;
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    currentTime = new Date('2024-01-15T10:00:00.000Z').getTime();
    store = new InMemoryIdempotencyStore(() => currentTime);
  });

  // ─── Basic Storage ─────────────────────────────────────────────────────

  describe('basic storage', () => {
    it('should store and retrieve a cached result', async () => {
      const response = createTestResponse();
      await store.set('key-1', response);

      const cached = await store.get('key-1');
      expect(cached).not.toBeNull();
      expect(cached!.response).toEqual(response);
      expect(cached!.idempotency_key).toBe('key-1');
    });

    it('should return null for non-existent key', async () => {
      const cached = await store.get('non-existent');
      expect(cached).toBeNull();
    });

    it('should store multiple entries independently', async () => {
      const response1 = createTestResponse({ action_id: 'action-1' as ActionId });
      const response2 = createTestResponse({ action_id: 'action-2' as ActionId });

      await store.set('key-1', response1);
      await store.set('key-2', response2);

      const cached1 = await store.get('key-1');
      const cached2 = await store.get('key-2');

      expect(cached1!.response.action_id).toBe('action-1');
      expect(cached2!.response.action_id).toBe('action-2');
    });

    it('should overwrite existing entry with same key', async () => {
      const response1 = createTestResponse({ outcome: 'SUCCESS' });
      const response2 = createTestResponse({ outcome: 'FAILURE' });

      await store.set('key-1', response1);
      await store.set('key-1', response2);

      const cached = await store.get('key-1');
      expect(cached!.response.outcome).toBe('FAILURE');
    });

    it('should set stored_at and expires_at timestamps', async () => {
      await store.set('key-1', createTestResponse());

      const cached = await store.get('key-1');
      expect(cached!.stored_at).toBe('2024-01-15T10:00:00.000Z');
      // 24 hours later
      expect(cached!.expires_at).toBe('2024-01-16T10:00:00.000Z');
    });
  });

  // ─── Expiration ────────────────────────────────────────────────────────

  describe('24-hour expiration', () => {
    it('should return cached result within 24h window', async () => {
      await store.set('key-1', createTestResponse());

      // Advance 23 hours 59 minutes
      currentTime += 23 * 60 * 60 * 1000 + 59 * 60 * 1000;

      const cached = await store.get('key-1');
      expect(cached).not.toBeNull();
    });

    it('should return null after 24h window expires', async () => {
      await store.set('key-1', createTestResponse());

      // Advance exactly 24 hours
      currentTime += 24 * 60 * 60 * 1000;

      const cached = await store.get('key-1');
      expect(cached).toBeNull();
    });

    it('should return null well after 24h window', async () => {
      await store.set('key-1', createTestResponse());

      // Advance 48 hours
      currentTime += 48 * 60 * 60 * 1000;

      const cached = await store.get('key-1');
      expect(cached).toBeNull();
    });

    it('should report has() correctly for expired entries', async () => {
      await store.set('key-1', createTestResponse());

      expect(await store.has('key-1')).toBe(true);

      // Advance past expiration
      currentTime += 25 * 60 * 60 * 1000;

      expect(await store.has('key-1')).toBe(false);
    });
  });

  // ─── Eviction ──────────────────────────────────────────────────────────

  describe('eviction', () => {
    it('should evict expired entries', async () => {
      await store.set('key-1', createTestResponse());
      await store.set('key-2', createTestResponse());

      // Advance past expiration
      currentTime += 25 * 60 * 60 * 1000;

      const evicted = await store.evictExpired();
      expect(evicted).toBe(2);
      expect(store.size).toBe(0);
    });

    it('should not evict non-expired entries', async () => {
      await store.set('key-1', createTestResponse());

      // Advance 12 hours (not expired)
      currentTime += 12 * 60 * 60 * 1000;

      await store.set('key-2', createTestResponse());

      // Advance another 13 hours (key-1 expired, key-2 not)
      currentTime += 13 * 60 * 60 * 1000;

      const evicted = await store.evictExpired();
      expect(evicted).toBe(1);
      expect(store.size).toBe(1);
      expect(await store.has('key-2')).toBe(true);
    });

    it('should return 0 when no entries are expired', async () => {
      await store.set('key-1', createTestResponse());

      const evicted = await store.evictExpired();
      expect(evicted).toBe(0);
    });

    it('should lazily remove expired entries on get()', async () => {
      await store.set('key-1', createTestResponse());
      expect(store.size).toBe(1);

      // Advance past expiration
      currentTime += 25 * 60 * 60 * 1000;

      // get() should remove the expired entry
      await store.get('key-1');
      expect(store.size).toBe(0);
    });
  });
});
