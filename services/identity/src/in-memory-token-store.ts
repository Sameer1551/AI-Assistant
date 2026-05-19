/**
 * @module in-memory-token-store
 * In-memory implementation of the ITokenStore interface.
 *
 * This implementation is suitable for development, testing, and single-instance
 * deployments. For production multi-instance deployments, swap this with a
 * Redis-backed or database-backed implementation that implements the same interface.
 *
 * @remarks
 * Marked as swappable — replace with a persistent store for production use.
 * The interface contract (ITokenStore) ensures any implementation is drop-in compatible.
 */

import type { SessionId } from '@may/types';
import type { ITokenStore, RefreshTokenRecord } from './interfaces/index.js';

/**
 * In-memory token store for refresh token management and revocation tracking.
 *
 * Stores refresh token records and revocation state in Maps.
 * Provides automatic cleanup of expired tokens via configurable sweep interval.
 *
 * @remarks
 * SWAPPABLE: This implementation stores all state in memory. For production
 * deployments requiring persistence across restarts or multi-instance consistency,
 * replace with a Redis, PostgreSQL, or other persistent implementation of ITokenStore.
 */
export class InMemoryTokenStore implements ITokenStore {
  private readonly refreshTokens: Map<string, RefreshTokenRecord> = new Map();
  private readonly revokedTokens: Set<string> = new Set();
  private readonly sessionTokens: Map<string, Set<string>> = new Map();
  private sweepIntervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new InMemoryTokenStore.
   *
   * @param sweepIntervalMs - Interval in ms for cleaning expired tokens (0 to disable). Default: 60000 (1 minute).
   */
  constructor(private readonly sweepIntervalMs: number = 60_000) {
    if (this.sweepIntervalMs > 0) {
      this.sweepIntervalHandle = setInterval(() => {
        this.sweepExpired();
      }, this.sweepIntervalMs);

      // Allow the process to exit even if the interval is running
      if (this.sweepIntervalHandle.unref) {
        this.sweepIntervalHandle.unref();
      }
    }
  }

  /**
   * Store a refresh token record.
   *
   * @param jti - Unique token identifier
   * @param record - Token metadata to store
   */
  async storeRefreshToken(jti: string, record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(jti, record);

    // Track token by session for session-level revocation
    const sessionId = record.session_id as string;
    const sessionSet = this.sessionTokens.get(sessionId) ?? new Set<string>();
    sessionSet.add(jti);
    this.sessionTokens.set(sessionId, sessionSet);
  }

  /**
   * Retrieve a refresh token record by its JTI.
   *
   * @param jti - Unique token identifier
   * @returns The stored record, or null if not found
   */
  async getRefreshToken(jti: string): Promise<RefreshTokenRecord | null> {
    return this.refreshTokens.get(jti) ?? null;
  }

  /**
   * Revoke a token by its JTI (marks it as revoked).
   *
   * @param jti - Unique token identifier to revoke
   */
  async revokeToken(jti: string): Promise<void> {
    this.revokedTokens.add(jti);

    // Update the stored record if it exists
    const record = this.refreshTokens.get(jti);
    if (record) {
      this.refreshTokens.set(jti, { ...record, revoked: true });
    }
  }

  /**
   * Check if a token JTI has been revoked.
   *
   * @param jti - Unique token identifier to check
   * @returns True if the token has been revoked
   */
  async isRevoked(jti: string): Promise<boolean> {
    return this.revokedTokens.has(jti);
  }

  /**
   * Revoke all tokens for a given session.
   *
   * @param sessionId - Session identifier whose tokens should be revoked
   */
  async revokeSession(sessionId: SessionId): Promise<void> {
    const sessionSet = this.sessionTokens.get(sessionId as string);
    if (sessionSet) {
      for (const jti of sessionSet) {
        this.revokedTokens.add(jti);
        const record = this.refreshTokens.get(jti);
        if (record) {
          this.refreshTokens.set(jti, { ...record, revoked: true });
        }
      }
    }
  }

  /**
   * Stop the background sweep timer. Call this when shutting down.
   */
  dispose(): void {
    if (this.sweepIntervalHandle) {
      clearInterval(this.sweepIntervalHandle);
      this.sweepIntervalHandle = null;
    }
  }

  /**
   * Get the count of stored tokens (for testing/monitoring).
   */
  get size(): number {
    return this.refreshTokens.size;
  }

  /**
   * Get the count of revoked tokens (for testing/monitoring).
   */
  get revokedCount(): number {
    return this.revokedTokens.size;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Remove expired tokens from storage to prevent unbounded memory growth.
   */
  private sweepExpired(): void {
    const now = Math.floor(Date.now() / 1000);

    for (const [jti, record] of this.refreshTokens) {
      if (record.exp <= now) {
        this.refreshTokens.delete(jti);
        this.revokedTokens.delete(jti);

        // Clean up session tracking
        const sessionSet = this.sessionTokens.get(record.session_id as string);
        if (sessionSet) {
          sessionSet.delete(jti);
          if (sessionSet.size === 0) {
            this.sessionTokens.delete(record.session_id as string);
          }
        }
      }
    }
  }
}
