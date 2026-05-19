/**
 * In-memory implementation of the idempotency store.
 *
 * Provides 24-hour deduplication for action requests. When the same
 * idempotency key is submitted within the 24-hour window, the cached
 * result is returned without re-executing the action.
 *
 * @see Requirement 2.7 - Idempotency keys with 24h deduplication window
 */

import type { ActionResponse } from '@may/types';
import type { CachedActionResult, IIdempotencyStore } from './interfaces/index.js';

/** 24 hours in milliseconds. */
const DEDUPLICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory idempotency store with automatic expiration.
 *
 * Stores action results keyed by idempotency key. Entries expire
 * after 24 hours. Expired entries are lazily evicted on access
 * and can be bulk-evicted via evictExpired().
 */
export class InMemoryIdempotencyStore implements IIdempotencyStore {
  private readonly cache: Map<string, CachedActionResult> = new Map();

  /**
   * Creates an InMemoryIdempotencyStore.
   *
   * @param getNow - Optional clock function for testing (returns current time in ms)
   */
  constructor(private readonly getNow: () => number = () => Date.now()) {}

  async get(idempotencyKey: string): Promise<CachedActionResult | null> {
    const entry = this.cache.get(idempotencyKey);
    if (!entry) {
      return null;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      this.cache.delete(idempotencyKey);
      return null;
    }

    return entry;
  }

  async set(idempotencyKey: string, response: ActionResponse): Promise<void> {
    const now = new Date(this.getNow());
    const expiresAt = new Date(now.getTime() + DEDUPLICATION_WINDOW_MS);

    const entry: CachedActionResult = {
      idempotency_key: idempotencyKey,
      response,
      stored_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    this.cache.set(idempotencyKey, entry);
  }

  async has(idempotencyKey: string): Promise<boolean> {
    const result = await this.get(idempotencyKey);
    return result !== null;
  }

  async evictExpired(): Promise<number> {
    let evicted = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Returns the current number of entries in the store (including expired).
   * Useful for testing and monitoring.
   */
  get size(): number {
    return this.cache.size;
  }

  private isExpired(entry: CachedActionResult): boolean {
    const expiresAtMs = new Date(entry.expires_at).getTime();
    return this.getNow() >= expiresAtMs;
  }
}
