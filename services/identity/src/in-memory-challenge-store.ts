/**
 * @module in-memory-challenge-store
 * In-memory implementation of IChallengeStore and ILockoutStore.
 *
 * Suitable for testing and single-instance deployments.
 * Production deployments should use a distributed store (e.g., Redis).
 */

import type { ChallengeId, SessionId, ConfirmationChallenge } from '@may/types';
import type { IChallengeStore, ILockoutStore } from './interfaces/confirmation-challenge.js';
import type { IClock } from './interfaces/index.js';

// ─── In-Memory Challenge Store ───────────────────────────────────────────────

/**
 * In-memory implementation of IChallengeStore.
 * Stores challenges in a Map keyed by challenge_id.
 */
export class InMemoryChallengeStore implements IChallengeStore {
  private readonly challenges = new Map<string, ConfirmationChallenge>();

  /** @inheritdoc */
  async store(challenge: ConfirmationChallenge): Promise<void> {
    this.challenges.set(challenge.challenge_id as string, challenge);
  }

  /** @inheritdoc */
  async get(challengeId: ChallengeId): Promise<ConfirmationChallenge | null> {
    return this.challenges.get(challengeId as string) ?? null;
  }

  /** @inheritdoc */
  async markConsumed(challengeId: ChallengeId): Promise<void> {
    const challenge = this.challenges.get(challengeId as string);
    if (challenge) {
      // Create a new object with consumed = true (immutable pattern)
      this.challenges.set(challengeId as string, {
        ...challenge,
        consumed: true,
      });
    }
  }

  /** @inheritdoc */
  async invalidate(challengeId: ChallengeId): Promise<void> {
    // Mark as consumed to prevent reuse
    await this.markConsumed(challengeId);
  }
}

// ─── In-Memory Lockout Store ─────────────────────────────────────────────────

/**
 * Lockout record for a session.
 */
interface LockoutRecord {
  /** Consecutive failure count. */
  failureCount: number;
  /** ISO timestamp when lockout expires (if locked out). */
  lockedUntil: string | null;
}

/**
 * In-memory implementation of ILockoutStore.
 * Tracks failed validation attempts and lockout state per session.
 */
export class InMemoryLockoutStore implements ILockoutStore {
  private readonly records = new Map<string, LockoutRecord>();
  private readonly clock: IClock;

  constructor(clock: IClock) {
    this.clock = clock;
  }

  /** @inheritdoc */
  async recordFailure(sessionId: SessionId): Promise<number> {
    const key = sessionId as string;
    const existing = this.records.get(key);
    const newCount = (existing?.failureCount ?? 0) + 1;
    this.records.set(key, {
      failureCount: newCount,
      lockedUntil: existing?.lockedUntil ?? null,
    });
    return newCount;
  }

  /** @inheritdoc */
  async resetFailures(sessionId: SessionId): Promise<void> {
    const key = sessionId as string;
    this.records.set(key, {
      failureCount: 0,
      lockedUntil: null,
    });
  }

  /** @inheritdoc */
  async getFailureCount(sessionId: SessionId): Promise<number> {
    const key = sessionId as string;
    return this.records.get(key)?.failureCount ?? 0;
  }

  /** @inheritdoc */
  async isLockedOut(sessionId: SessionId): Promise<boolean> {
    const key = sessionId as string;
    const record = this.records.get(key);
    if (!record?.lockedUntil) {
      return false;
    }
    // Check if lockout has expired
    const lockoutTime = new Date(record.lockedUntil).getTime();
    const nowMs = this.clock.nowSeconds() * 1000;
    if (nowMs >= lockoutTime) {
      // Lockout expired — clear it
      record.lockedUntil = null;
      record.failureCount = 0;
      return false;
    }
    return true;
  }

  /** @inheritdoc */
  async lockOut(sessionId: SessionId, until: string): Promise<void> {
    const key = sessionId as string;
    const existing = this.records.get(key);
    this.records.set(key, {
      failureCount: existing?.failureCount ?? 0,
      lockedUntil: until,
    });
  }
}
