/**
 * Unit tests for RateLimiter — sliding window rate limiting.
 *
 * Verifies:
 * - Per-tenant rate limiting
 * - Per-principal rate limiting
 * - Retry-After calculation
 * - Configuration updates
 * - Window sliding behavior
 * - Reset functionality
 *
 * @see Requirement 4.9 — per-Tenant and per-principal request rate limits
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';
import type { IClock } from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentMs = new Date('2024-01-01T00:00:00.000Z').getTime();

  nowISO(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceMs(ms: number): void {
    this.currentMs += ms;
  }

  setTime(iso: string): void {
    this.currentMs = new Date(iso).getTime();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let clock: MockClock;
  let limiter: RateLimiter;

  beforeEach(() => {
    clock = new MockClock();
    limiter = new RateLimiter(clock);
  });

  describe('default limits', () => {
    it('allows requests within default tenant limit (60/min)', () => {
      for (let i = 0; i < 20; i++) {
        const result = limiter.checkLimit('tenant-1', `user-${i}`);
        expect(result.allowed).toBe(true);
      }
    });

    it('rejects when default principal limit (20/min) is exceeded', () => {
      // Use up the principal limit
      for (let i = 0; i < 20; i++) {
        const result = limiter.checkLimit('tenant-1', 'user-1');
        expect(result.allowed).toBe(true);
      }

      // Next request should be rejected
      const result = limiter.checkLimit('tenant-1', 'user-1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retry_after_ms).toBeGreaterThan(0);
    });
  });

  describe('configured limits', () => {
    beforeEach(() => {
      limiter.configure(
        'tenant-1',
        { max_requests: 5, window_ms: 10_000 },
        { max_requests: 3, window_ms: 10_000 },
      );
    });

    it('enforces configured tenant limit', () => {
      // 5 requests from different principals should work
      for (let i = 0; i < 5; i++) {
        const result = limiter.checkLimit('tenant-1', `user-${i}`);
        expect(result.allowed).toBe(true);
      }

      // 6th request should be rejected (tenant limit)
      const result = limiter.checkLimit('tenant-1', 'user-99');
      expect(result.allowed).toBe(false);
    });

    it('enforces configured principal limit', () => {
      // 3 requests from same principal should work
      for (let i = 0; i < 3; i++) {
        const result = limiter.checkLimit('tenant-1', 'user-1');
        expect(result.allowed).toBe(true);
      }

      // 4th request should be rejected (principal limit)
      const result = limiter.checkLimit('tenant-1', 'user-1');
      expect(result.allowed).toBe(false);
    });

    it('provides correct Retry-After value', () => {
      // Exhaust the principal limit
      for (let i = 0; i < 3; i++) {
        limiter.checkLimit('tenant-1', 'user-1');
      }

      const result = limiter.checkLimit('tenant-1', 'user-1');
      expect(result.allowed).toBe(false);
      // Retry-After should be approximately the window duration
      expect(result.retry_after_ms).toBeGreaterThan(0);
      expect(result.retry_after_ms).toBeLessThanOrEqual(10_000);
    });
  });

  describe('sliding window behavior', () => {
    beforeEach(() => {
      limiter.configure(
        'tenant-1',
        { max_requests: 10, window_ms: 10_000 },
        { max_requests: 5, window_ms: 10_000 },
      );
    });

    it('allows requests after window slides past old requests', () => {
      // Make 5 requests (exhaust principal limit)
      for (let i = 0; i < 5; i++) {
        limiter.checkLimit('tenant-1', 'user-1');
      }

      // Should be rejected now
      expect(limiter.checkLimit('tenant-1', 'user-1').allowed).toBe(false);

      // Advance time past the window
      clock.advanceMs(10_001);

      // Should be allowed again
      const result = limiter.checkLimit('tenant-1', 'user-1');
      expect(result.allowed).toBe(true);
    });

    it('partially recovers as old requests slide out of window', () => {
      // Make 3 requests
      for (let i = 0; i < 3; i++) {
        limiter.checkLimit('tenant-1', 'user-1');
        clock.advanceMs(2_000); // 2s between each
      }

      // Make 2 more (total 5, at limit)
      for (let i = 0; i < 2; i++) {
        limiter.checkLimit('tenant-1', 'user-1');
      }

      // Should be rejected
      expect(limiter.checkLimit('tenant-1', 'user-1').allowed).toBe(false);

      // Advance 5s — first 3 requests should slide out (they were at t=0, t=2s, t=4s)
      clock.advanceMs(5_000);

      // Now the first request (at t=0) is outside the 10s window (current time is ~11s)
      // So we should have capacity again
      const result = limiter.checkLimit('tenant-1', 'user-1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('tenant isolation', () => {
    beforeEach(() => {
      limiter.configure(
        'tenant-1',
        { max_requests: 3, window_ms: 10_000 },
        { max_requests: 2, window_ms: 10_000 },
      );
      limiter.configure(
        'tenant-2',
        { max_requests: 3, window_ms: 10_000 },
        { max_requests: 2, window_ms: 10_000 },
      );
    });

    it('rate limits are independent per tenant', () => {
      // Exhaust tenant-1's principal limit
      limiter.checkLimit('tenant-1', 'user-1');
      limiter.checkLimit('tenant-1', 'user-1');
      expect(limiter.checkLimit('tenant-1', 'user-1').allowed).toBe(false);

      // tenant-2 should still be fine
      const result = limiter.checkLimit('tenant-2', 'user-1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('getStatus', () => {
    beforeEach(() => {
      limiter.configure(
        'tenant-1',
        { max_requests: 10, window_ms: 10_000 },
        { max_requests: 5, window_ms: 10_000 },
      );
    });

    it('returns current status without consuming quota', () => {
      limiter.checkLimit('tenant-1', 'user-1');
      limiter.checkLimit('tenant-1', 'user-1');

      const status = limiter.getStatus('tenant-1', 'user-1');
      expect(status.allowed).toBe(true);
      expect(status.remaining).toBe(3); // 5 - 2 = 3

      // Calling getStatus again should return the same result
      const status2 = limiter.getStatus('tenant-1', 'user-1');
      expect(status2.remaining).toBe(3);
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      limiter.configure(
        'tenant-1',
        { max_requests: 3, window_ms: 10_000 },
        { max_requests: 2, window_ms: 10_000 },
      );
    });

    it('resets all counters for a tenant', () => {
      // Exhaust limits
      limiter.checkLimit('tenant-1', 'user-1');
      limiter.checkLimit('tenant-1', 'user-1');
      expect(limiter.checkLimit('tenant-1', 'user-1').allowed).toBe(false);

      // Reset
      limiter.reset('tenant-1');

      // Should be allowed again
      const result = limiter.checkLimit('tenant-1', 'user-1');
      expect(result.allowed).toBe(true);
    });

    it('does not affect other tenants', () => {
      limiter.configure(
        'tenant-2',
        { max_requests: 3, window_ms: 10_000 },
        { max_requests: 2, window_ms: 10_000 },
      );

      limiter.checkLimit('tenant-2', 'user-1');
      limiter.checkLimit('tenant-2', 'user-1');

      // Reset tenant-1 only
      limiter.reset('tenant-1');

      // tenant-2 should still have its usage
      const status = limiter.getStatus('tenant-2', 'user-1');
      expect(status.remaining).toBe(0);
    });
  });
});
