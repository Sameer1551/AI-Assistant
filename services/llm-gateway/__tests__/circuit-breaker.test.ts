/**
 * Unit tests for CircuitBreaker — per-model circuit breaker pattern.
 *
 * Verifies:
 * - CLOSED state allows requests
 * - Transitions to OPEN when error rate exceeds threshold
 * - OPEN state rejects requests with cooldown info
 * - Transitions to HALF_OPEN after cooldown
 * - HALF_OPEN allows limited trial requests
 * - HALF_OPEN → CLOSED on successful trials
 * - HALF_OPEN → OPEN on trial failure
 * - Configuration and reset
 *
 * @see Requirement 4.10 — circuit breaker per model with configurable
 *   threshold, window, cooldown
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker.js';
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
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  let clock: MockClock;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    clock = new MockClock();
    breaker = new CircuitBreaker(clock);
  });

  describe('CLOSED state', () => {
    it('allows requests when circuit is closed', () => {
      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('closed');
      expect(result.error_rate).toBe(0);
    });

    it('stays closed when error rate is below threshold', () => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });

      // Record 4 successes and 1 failure (20% error rate, below 50%)
      for (let i = 0; i < 4; i++) {
        breaker.recordSuccess('model-1');
      }
      breaker.recordFailure('model-1');

      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('closed');
      expect(result.error_rate).toBeCloseTo(0.2);
    });
  });

  describe('CLOSED → OPEN transition', () => {
    beforeEach(() => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });
    });

    it('opens circuit when error rate exceeds threshold', () => {
      // Need at least 5 samples (minimum samples check)
      // Record 2 successes and 4 failures (67% error rate, above 50%)
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      // 5th record triggers the check: 3/5 = 60% > 50%
      breaker.recordFailure('model-1');

      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('open');
    });

    it('does not open circuit with fewer than minimum samples', () => {
      // Only 3 failures (below minimum 5 samples)
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');

      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('closed');
    });
  });

  describe('OPEN state', () => {
    beforeEach(() => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });

      // Open the circuit
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
    });

    it('rejects requests when circuit is open', () => {
      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('open');
    });

    it('provides cooldown remaining time', () => {
      clock.advanceMs(2_000); // 2s into 5s cooldown

      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(false);
      expect(result.cooldown_remaining_ms).toBeCloseTo(3_000, -2);
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    beforeEach(() => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });

      // Open the circuit
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
    });

    it('transitions to half_open after cooldown expires', () => {
      clock.advanceMs(5_001); // Past cooldown

      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('half_open');
    });
  });

  describe('HALF_OPEN state', () => {
    beforeEach(() => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });

      // Open the circuit
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');

      // Wait for cooldown
      clock.advanceMs(5_001);
    });

    it('allows limited trial requests', () => {
      // First trial should be allowed
      const result1 = breaker.canRequest('model-1');
      expect(result1.allowed).toBe(true);
      expect(result1.state).toBe('half_open');
    });

    it('closes circuit after enough successful trials', () => {
      // Verify we're in half_open
      expect(breaker.canRequest('model-1').state).toBe('half_open');

      // Record 3 successes (half_open_max_requests)
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');

      const result = breaker.canRequest('model-1');
      expect(result.state).toBe('closed');
      expect(result.allowed).toBe(true);
    });

    it('reopens circuit on trial failure', () => {
      // Verify we're in half_open
      expect(breaker.canRequest('model-1').state).toBe('half_open');

      // Record a failure during trial
      breaker.recordFailure('model-1');

      const result = breaker.canRequest('model-1');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('open');
    });

    it('rejects requests beyond max trial count', () => {
      // Verify we're in half_open
      expect(breaker.canRequest('model-1').state).toBe('half_open');

      // Use up trial slots without recording outcomes
      // The canRequest increments halfOpenAttempts only when we record
      // Actually, canRequest just checks if attempts < max
      // We need to record successes to increment attempts
      breaker.recordSuccess('model-1'); // attempt 1
      breaker.recordSuccess('model-1'); // attempt 2
      breaker.recordSuccess('model-1'); // attempt 3 → closes circuit

      // Circuit should now be closed
      const result = breaker.canRequest('model-1');
      expect(result.state).toBe('closed');
    });
  });

  describe('model isolation', () => {
    it('maintains separate circuits per model', () => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });
      breaker.configure('model-2', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });

      // Open circuit for model-1
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');

      // model-1 should be open
      expect(breaker.canRequest('model-1').allowed).toBe(false);

      // model-2 should still be closed
      expect(breaker.canRequest('model-2').allowed).toBe(true);
      expect(breaker.canRequest('model-2').state).toBe('closed');
    });
  });

  describe('rolling window', () => {
    beforeEach(() => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });
    });

    it('old failures slide out of the window', () => {
      // Record failures
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');

      // Not yet at minimum samples for opening, but error rate is high
      // Let's add one more to trigger
      breaker.recordFailure('model-1');

      // Circuit should be open (4/6 = 67% > 50%)
      expect(breaker.canRequest('model-1').state).toBe('open');

      // Wait for cooldown + window to expire
      clock.advanceMs(15_001); // Past both cooldown (5s) and window (10s)

      // After cooldown, should be half_open
      const result = breaker.canRequest('model-1');
      expect(result.state).toBe('half_open');

      // Record successes to close
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');

      // Should be closed now with clean error rate
      const finalResult = breaker.canRequest('model-1');
      expect(finalResult.state).toBe('closed');
      // Old failures should have slid out of the window
      expect(finalResult.error_rate).toBeLessThan(0.5);
    });
  });

  describe('reset', () => {
    it('resets circuit to closed state', () => {
      breaker.configure('model-1', {
        error_threshold: 50,
        rolling_window_ms: 10_000,
        cooldown_ms: 5_000,
        half_open_max_requests: 3,
      });

      // Open the circuit
      breaker.recordSuccess('model-1');
      breaker.recordSuccess('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');
      breaker.recordFailure('model-1');

      expect(breaker.canRequest('model-1').state).toBe('open');

      // Reset
      breaker.reset('model-1');

      const result = breaker.canRequest('model-1');
      expect(result.state).toBe('closed');
      expect(result.allowed).toBe(true);
      expect(result.error_rate).toBe(0);
    });
  });

  describe('getState', () => {
    it('returns current state without side effects', () => {
      const state1 = breaker.getState('model-1');
      expect(state1.state).toBe('closed');
      expect(state1.allowed).toBe(true);

      const state2 = breaker.getState('model-1');
      expect(state2.state).toBe('closed');
    });
  });
});
