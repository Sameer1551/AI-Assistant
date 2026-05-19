/**
 * Property-based tests for rate limiting, budget enforcement, and circuit breaker.
 *
 * **Validates: Requirements 4.8, 4.9, 4.10**
 *
 * Property 18: Budget Enforcement — reject with BUDGET_EXCEEDED when tenant
 *   budget exceeded. For any sequence of usage recordings that exceed the
 *   configured daily or monthly limit, subsequent budget checks must return
 *   allowed=false.
 *
 * Property 19: Rate Limiting — reject with RATE_LIMITED and Retry-After when
 *   limits exceeded. For any sequence of requests, once the configured limit
 *   is reached, subsequent requests must be rejected with a positive
 *   Retry-After value.
 *
 * Property 20: Circuit Breaker Activation — open circuit when error rate
 *   exceeds threshold in rolling window. For any sequence of failures that
 *   causes the error rate to exceed the configured threshold (with minimum
 *   samples), the circuit must transition to open state and reject subsequent
 *   requests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fc } from '@may/testing';
import { RateLimiter } from '../src/rate-limiter.js';
import { BudgetEnforcer } from '../src/budget-enforcer.js';
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

  setTime(iso: string): void {
    this.currentMs = new Date(iso).getTime();
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for tenant IDs. */
const tenantIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `tenant-${s}`);

/** Arbitrary for principal IDs. */
const principalIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 12 },
).map((s) => `user-${s}`);

/** Arbitrary for rate limit configurations with small limits for testability. */
const rateLimitConfigArb = fc.record({
  max_requests: fc.integer({ min: 1, max: 20 }),
  window_ms: fc.integer({ min: 1000, max: 60_000 }),
});

/** Arbitrary for budget configurations. */
const budgetConfigArb = fc.record({
  daily_limit: fc.double({ min: 10, max: 1000, noNaN: true }),
  monthly_limit: fc.double({ min: 100, max: 10000, noNaN: true }),
}).filter((c) => c.monthly_limit >= c.daily_limit);

/** Arbitrary for cost amounts (positive). */
const costAmountArb = fc.double({ min: 0.01, max: 50, noNaN: true });

/** Arbitrary for circuit breaker configurations. */
const circuitBreakerConfigArb = fc.record({
  error_threshold: fc.integer({ min: 10, max: 90 }),
  rolling_window_ms: fc.integer({ min: 5000, max: 120_000 }),
  cooldown_ms: fc.integer({ min: 1000, max: 60_000 }),
  half_open_max_requests: fc.integer({ min: 1, max: 5 }),
});

/** Arbitrary for model IDs. */
const modelIdArb = fc.constantFrom(
  'gpt-4', 'gpt-3.5-turbo', 'claude-3', 'llama-3', 'mistral-7b',
);

// ─── Property 19: Rate Limiting ──────────────────────────────────────────────

describe('Property 19: Rate Limiting', () => {
  /**
   * **Validates: Requirements 4.9**
   *
   * For any sequence of requests, once the configured limit is reached,
   * subsequent requests must be rejected with a positive Retry-After value.
   */
  it('rejects with positive Retry-After once per-tenant limit is reached', () => {
    fc.assert(
      fc.property(
        tenantIdArb,
        principalIdArb,
        rateLimitConfigArb,
        (tenantId, principalId, tenantConfig) => {
          const clock = new MockClock();
          const limiter = new RateLimiter(clock);

          // Configure with the generated tenant limit and a very high principal limit
          // so we only test the tenant limit
          limiter.configure(tenantId, tenantConfig, { max_requests: 10000, window_ms: tenantConfig.window_ms });

          // Consume all allowed requests
          for (let i = 0; i < tenantConfig.max_requests; i++) {
            const result = limiter.checkLimit(tenantId, principalId);
            expect(result.allowed).toBe(true);
          }

          // Next request must be rejected with positive Retry-After
          const rejected = limiter.checkLimit(tenantId, principalId);
          expect(rejected.allowed).toBe(false);
          expect(rejected.retry_after_ms).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('rejects with positive Retry-After once per-principal limit is reached', () => {
    fc.assert(
      fc.property(
        tenantIdArb,
        principalIdArb,
        rateLimitConfigArb,
        (tenantId, principalId, principalConfig) => {
          const clock = new MockClock();
          const limiter = new RateLimiter(clock);

          // Configure with a very high tenant limit so we only test the principal limit
          limiter.configure(tenantId, { max_requests: 10000, window_ms: principalConfig.window_ms }, principalConfig);

          // Consume all allowed requests for this principal
          for (let i = 0; i < principalConfig.max_requests; i++) {
            const result = limiter.checkLimit(tenantId, principalId);
            expect(result.allowed).toBe(true);
          }

          // Next request must be rejected with positive Retry-After
          const rejected = limiter.checkLimit(tenantId, principalId);
          expect(rejected.allowed).toBe(false);
          expect(rejected.retry_after_ms).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('Retry-After value is bounded by the window duration', () => {
    fc.assert(
      fc.property(
        tenantIdArb,
        principalIdArb,
        rateLimitConfigArb,
        (tenantId, principalId, config) => {
          const clock = new MockClock();
          const limiter = new RateLimiter(clock);

          limiter.configure(tenantId, config, { max_requests: 10000, window_ms: config.window_ms });

          // Exhaust the limit
          for (let i = 0; i < config.max_requests; i++) {
            limiter.checkLimit(tenantId, principalId);
          }

          // Retry-After should not exceed the window duration
          const rejected = limiter.checkLimit(tenantId, principalId);
          expect(rejected.retry_after_ms).toBeLessThanOrEqual(config.window_ms);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 18: Budget Enforcement ─────────────────────────────────────────

describe('Property 18: Budget Enforcement', () => {
  /**
   * **Validates: Requirements 4.8**
   *
   * For any sequence of usage recordings that exceed the configured daily
   * or monthly limit, subsequent budget checks must return allowed=false.
   */
  it('rejects when daily budget is exceeded', () => {
    fc.assert(
      fc.property(
        tenantIdArb,
        budgetConfigArb,
        fc.array(costAmountArb, { minLength: 1, maxLength: 30 }),
        (tenantId, budgetConfig, costs) => {
          const clock = new MockClock();
          const enforcer = new BudgetEnforcer(clock);

          enforcer.configure({
            tenant_id: tenantId,
            daily_limit: budgetConfig.daily_limit,
            monthly_limit: budgetConfig.monthly_limit,
            hard_limit_action: 'reject',
            warning_thresholds: [0.5, 0.75, 0.9],
          });

          // Record usage until we exceed the daily limit
          let totalRecorded = 0;
          for (const cost of costs) {
            enforcer.recordUsageForTenant(tenantId, {
              cost_units: cost,
              timestamp: clock.nowISO(),
              model_id: 'gpt-4',
              principal_id: 'user-1',
              tokens: { prompt: 100, completion: 50 },
            });
            totalRecorded += cost;

            if (totalRecorded > budgetConfig.daily_limit) {
              // Once we've exceeded the daily limit, budget check must reject
              const result = enforcer.checkBudget(tenantId, 0.01);
              expect(result.allowed).toBe(false);
              return; // Property verified
            }
          }

          // If we didn't exceed the limit with the generated costs, that's fine —
          // the property only applies when the limit IS exceeded
        },
      ),
      { numRuns: 50 },
    );
  });

  it('rejects when monthly budget is exceeded', () => {
    fc.assert(
      fc.property(
        tenantIdArb,
        fc.double({ min: 10, max: 100, noNaN: true }),
        fc.array(costAmountArb, { minLength: 1, maxLength: 50 }),
        (tenantId, monthlyLimit, costs) => {
          const clock = new MockClock();
          const enforcer = new BudgetEnforcer(clock);

          // Set daily limit very high so only monthly limit matters
          enforcer.configure({
            tenant_id: tenantId,
            daily_limit: 999999,
            monthly_limit: monthlyLimit,
            hard_limit_action: 'reject',
            warning_thresholds: [0.5, 0.75, 0.9],
          });

          // Record usage until we exceed the monthly limit
          let totalRecorded = 0;
          for (const cost of costs) {
            enforcer.recordUsageForTenant(tenantId, {
              cost_units: cost,
              timestamp: clock.nowISO(),
              model_id: 'gpt-4',
              principal_id: 'user-1',
              tokens: { prompt: 100, completion: 50 },
            });
            totalRecorded += cost;

            if (totalRecorded > monthlyLimit) {
              // Once we've exceeded the monthly limit, budget check must reject
              const result = enforcer.checkBudget(tenantId, 0.01);
              expect(result.allowed).toBe(false);
              return; // Property verified
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('allows requests when budget is not exceeded', () => {
    fc.assert(
      fc.property(
        tenantIdArb,
        budgetConfigArb,
        fc.array(
          fc.double({ min: 0.001, max: 0.5, noNaN: true }),
          { minLength: 1, maxLength: 5 },
        ),
        (tenantId, budgetConfig, costs) => {
          const clock = new MockClock();
          const enforcer = new BudgetEnforcer(clock);

          enforcer.configure({
            tenant_id: tenantId,
            daily_limit: budgetConfig.daily_limit,
            monthly_limit: budgetConfig.monthly_limit,
            hard_limit_action: 'reject',
            warning_thresholds: [0.5, 0.75, 0.9],
          });

          // Record small amounts that won't exceed the limit
          const totalCost = costs.reduce((sum, c) => sum + c, 0);
          if (totalCost >= budgetConfig.daily_limit) {
            return; // Skip if generated costs would exceed — not relevant to this property
          }

          for (const cost of costs) {
            enforcer.recordUsageForTenant(tenantId, {
              cost_units: cost,
              timestamp: clock.nowISO(),
              model_id: 'gpt-4',
              principal_id: 'user-1',
              tokens: { prompt: 100, completion: 50 },
            });
          }

          // Budget check should still allow
          const result = enforcer.checkBudget(tenantId, 0.01);
          expect(result.allowed).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 20: Circuit Breaker Activation ─────────────────────────────────

describe('Property 20: Circuit Breaker Activation', () => {
  /**
   * **Validates: Requirements 4.10**
   *
   * For any sequence of failures that causes the error rate in the rolling
   * window to exceed the configured threshold (with minimum samples), the
   * circuit must transition to open state and reject subsequent requests.
   */
  it('opens circuit when error rate exceeds threshold with minimum samples', () => {
    fc.assert(
      fc.property(
        modelIdArb,
        circuitBreakerConfigArb,
        (modelId, config) => {
          const clock = new MockClock();
          const breaker = new CircuitBreaker(clock);

          breaker.configure(modelId, config);

          // The circuit breaker requires at least 5 samples (minimum samples)
          // and error rate >= threshold/100 to open.
          // We'll generate enough failures to exceed the threshold.
          const minSamples = 5;
          const thresholdFraction = config.error_threshold / 100;

          // Calculate how many failures we need to exceed the threshold
          // with exactly minSamples total requests.
          // We need: failures / total >= thresholdFraction
          // So: failures >= ceil(total * thresholdFraction)
          const totalRequests = Math.max(minSamples, 10);
          const failuresNeeded = Math.ceil(totalRequests * thresholdFraction);
          const successesNeeded = totalRequests - failuresNeeded;

          // Record successes first
          for (let i = 0; i < successesNeeded; i++) {
            breaker.recordSuccess(modelId);
            clock.advanceMs(10);
          }

          // Record failures to exceed the threshold
          for (let i = 0; i < failuresNeeded; i++) {
            breaker.recordFailure(modelId);
            clock.advanceMs(10);
          }

          // After exceeding the threshold with minimum samples,
          // the circuit should be open and reject requests
          const result = breaker.canRequest(modelId);
          expect(result.state).toBe('open');
          expect(result.allowed).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('remains closed when error rate is below threshold', () => {
    fc.assert(
      fc.property(
        modelIdArb,
        circuitBreakerConfigArb,
        (modelId, config) => {
          const clock = new MockClock();
          const breaker = new CircuitBreaker(clock);

          breaker.configure(modelId, config);

          const thresholdFraction = config.error_threshold / 100;

          // Record enough requests to have minimum samples,
          // but keep error rate well below threshold.
          // We want: failures / total < thresholdFraction
          const totalRequests = 10;
          // Use at most (threshold - 1) percent failures to stay below
          const maxFailures = Math.max(0, Math.floor(totalRequests * thresholdFraction) - 1);

          // Record successes
          for (let i = 0; i < totalRequests - maxFailures; i++) {
            breaker.recordSuccess(modelId);
            clock.advanceMs(10);
          }

          // Record a few failures (below threshold)
          for (let i = 0; i < maxFailures; i++) {
            breaker.recordFailure(modelId);
            clock.advanceMs(10);
          }

          // Circuit should remain closed
          const result = breaker.canRequest(modelId);
          expect(result.state).toBe('closed');
          expect(result.allowed).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('rejects all requests while circuit is open', () => {
    fc.assert(
      fc.property(
        modelIdArb,
        circuitBreakerConfigArb,
        fc.integer({ min: 1, max: 10 }),
        (modelId, config, additionalRequests) => {
          const clock = new MockClock();
          const breaker = new CircuitBreaker(clock);

          breaker.configure(modelId, config);

          // Force the circuit open by recording enough failures
          const minSamples = 5;
          const thresholdFraction = config.error_threshold / 100;
          const totalRequests = Math.max(minSamples, 10);
          const failuresNeeded = Math.ceil(totalRequests * thresholdFraction);
          const successesNeeded = totalRequests - failuresNeeded;

          for (let i = 0; i < successesNeeded; i++) {
            breaker.recordSuccess(modelId);
            clock.advanceMs(10);
          }
          for (let i = 0; i < failuresNeeded; i++) {
            breaker.recordFailure(modelId);
            clock.advanceMs(10);
          }

          // Verify circuit is open
          expect(breaker.canRequest(modelId).state).toBe('open');

          // All subsequent requests should be rejected while open
          // (advance time but stay within cooldown)
          for (let i = 0; i < additionalRequests; i++) {
            clock.advanceMs(1); // Small advance, well within cooldown
            const result = breaker.canRequest(modelId);
            expect(result.allowed).toBe(false);
            expect(result.state).toBe('open');
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
