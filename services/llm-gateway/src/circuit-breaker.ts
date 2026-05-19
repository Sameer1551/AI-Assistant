/**
 * Circuit breaker implementation for the LLM Gateway.
 *
 * Implements the circuit breaker pattern with three states:
 * - CLOSED: Normal operation, requests pass through. Error rate is monitored.
 * - OPEN: All requests are rejected immediately. Transitions to HALF_OPEN after cooldown.
 * - HALF_OPEN: Limited trial requests allowed. Success closes circuit, failure reopens.
 *
 * Uses a rolling window to calculate error rates, preventing stale failures
 * from keeping the circuit open indefinitely.
 *
 * @see Requirement 4.10 — open circuit breaker when error rate exceeds threshold
 *   in rolling window, cooldown before closing
 */

import type {
  ICircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerCheckResult,
  CircuitBreakerInstanceConfig,
} from './interfaces/circuit-breaker.js';
import type { IClock } from './interfaces/index.js';

/**
 * Default circuit breaker configuration.
 */
const DEFAULT_CONFIG: CircuitBreakerInstanceConfig = {
  error_threshold: 50, // 50% error rate
  rolling_window_ms: 60_000, // 1 minute window
  cooldown_ms: 30_000, // 30 second cooldown
  half_open_max_requests: 3, // 3 trial requests in half-open
};

/**
 * Internal record of a request outcome within the rolling window.
 */
interface RequestRecord {
  readonly timestamp: number;
  readonly success: boolean;
}

/**
 * Internal state for a single model's circuit breaker.
 */
interface CircuitState {
  /** Current state of the circuit. */
  state: CircuitBreakerState;

  /** Configuration for this circuit. */
  config: CircuitBreakerInstanceConfig;

  /** Request records within the rolling window. */
  records: RequestRecord[];

  /** Timestamp when the circuit was opened (for cooldown calculation). */
  openedAt: number | null;

  /** Number of successful trial requests in HALF_OPEN state. */
  halfOpenSuccesses: number;

  /** Number of requests attempted in HALF_OPEN state. */
  halfOpenAttempts: number;
}

/**
 * Circuit breaker implementation for model providers.
 *
 * Manages per-model circuit breakers that prevent cascading failures
 * by stopping requests to unhealthy model providers. Uses a rolling
 * window to calculate error rates and supports configurable thresholds,
 * cooldown periods, and half-open trial counts.
 *
 * @see Requirement 4.10 — circuit breaker per model with configurable
 *   threshold, window, cooldown
 */
export class CircuitBreaker implements ICircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(private readonly clock: IClock) {}

  canRequest(modelId: string): CircuitBreakerCheckResult {
    const circuit = this.getOrCreateCircuit(modelId);
    const now = this.nowMs();

    // Handle state transitions based on time
    this.updateState(circuit, now);

    switch (circuit.state) {
      case 'closed':
        return {
          allowed: true,
          state: 'closed',
          error_rate: this.calculateErrorRate(circuit, now),
          model_id: modelId,
          cooldown_remaining_ms: 0,
        };

      case 'open': {
        const cooldownRemaining = this.getCooldownRemaining(circuit, now);
        return {
          allowed: false,
          state: 'open',
          error_rate: this.calculateErrorRate(circuit, now),
          model_id: modelId,
          cooldown_remaining_ms: cooldownRemaining,
        };
      }

      case 'half_open': {
        // Allow limited trial requests
        const allowed = circuit.halfOpenAttempts < circuit.config.half_open_max_requests;
        return {
          allowed,
          state: 'half_open',
          error_rate: this.calculateErrorRate(circuit, now),
          model_id: modelId,
          cooldown_remaining_ms: 0,
        };
      }
    }
  }

  recordSuccess(modelId: string): void {
    const circuit = this.getOrCreateCircuit(modelId);
    const now = this.nowMs();

    this.updateState(circuit, now);

    circuit.records.push({ timestamp: now, success: true });

    if (circuit.state === 'half_open') {
      circuit.halfOpenSuccesses++;
      circuit.halfOpenAttempts++;

      // If enough successes in half-open, close the circuit
      if (circuit.halfOpenSuccesses >= circuit.config.half_open_max_requests) {
        circuit.state = 'closed';
        circuit.openedAt = null;
        circuit.halfOpenSuccesses = 0;
        circuit.halfOpenAttempts = 0;
      }
    }

    // Prune old records
    this.pruneRecords(circuit, now);
  }

  recordFailure(modelId: string): void {
    const circuit = this.getOrCreateCircuit(modelId);
    const now = this.nowMs();

    this.updateState(circuit, now);

    circuit.records.push({ timestamp: now, success: false });

    if (circuit.state === 'half_open') {
      // Any failure in half-open reopens the circuit
      circuit.halfOpenAttempts++;
      circuit.state = 'open';
      circuit.openedAt = now;
      circuit.halfOpenSuccesses = 0;
      circuit.halfOpenAttempts = 0;
    } else if (circuit.state === 'closed') {
      // Check if error rate now exceeds threshold
      const errorRate = this.calculateErrorRate(circuit, now);
      const thresholdFraction = circuit.config.error_threshold / 100;

      if (errorRate >= thresholdFraction && this.hasMinimumSamples(circuit, now)) {
        circuit.state = 'open';
        circuit.openedAt = now;
      }
    }

    // Prune old records
    this.pruneRecords(circuit, now);
  }

  configure(modelId: string, config: CircuitBreakerInstanceConfig): void {
    const existing = this.circuits.get(modelId);
    if (existing) {
      existing.config = config;
    } else {
      this.circuits.set(modelId, {
        state: 'closed',
        config,
        records: [],
        openedAt: null,
        halfOpenSuccesses: 0,
        halfOpenAttempts: 0,
      });
    }
  }

  getState(modelId: string): CircuitBreakerCheckResult {
    return this.canRequest(modelId);
  }

  reset(modelId: string): void {
    const circuit = this.circuits.get(modelId);
    if (circuit) {
      circuit.state = 'closed';
      circuit.records = [];
      circuit.openedAt = null;
      circuit.halfOpenSuccesses = 0;
      circuit.halfOpenAttempts = 0;
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private nowMs(): number {
    return new Date(this.clock.nowISO()).getTime();
  }

  private getOrCreateCircuit(modelId: string): CircuitState {
    let circuit = this.circuits.get(modelId);
    if (!circuit) {
      circuit = {
        state: 'closed',
        config: { ...DEFAULT_CONFIG },
        records: [],
        openedAt: null,
        halfOpenSuccesses: 0,
        halfOpenAttempts: 0,
      };
      this.circuits.set(modelId, circuit);
    }
    return circuit;
  }

  /**
   * Update circuit state based on time (OPEN → HALF_OPEN transition).
   */
  private updateState(circuit: CircuitState, now: number): void {
    if (circuit.state === 'open' && circuit.openedAt !== null) {
      const elapsed = now - circuit.openedAt;
      if (elapsed >= circuit.config.cooldown_ms) {
        circuit.state = 'half_open';
        circuit.halfOpenSuccesses = 0;
        circuit.halfOpenAttempts = 0;
      }
    }
  }

  /**
   * Calculate the error rate within the rolling window.
   * Returns a value between 0.0 and 1.0.
   */
  private calculateErrorRate(circuit: CircuitState, now: number): number {
    const windowStart = now - circuit.config.rolling_window_ms;
    const windowRecords = circuit.records.filter((r) => r.timestamp > windowStart);

    if (windowRecords.length === 0) {
      return 0;
    }

    const failures = windowRecords.filter((r) => !r.success).length;
    return failures / windowRecords.length;
  }

  /**
   * Check if there are enough samples in the window to make a decision.
   * Prevents opening the circuit on a single failure.
   */
  private hasMinimumSamples(circuit: CircuitState, now: number): boolean {
    const windowStart = now - circuit.config.rolling_window_ms;
    const windowRecords = circuit.records.filter((r) => r.timestamp > windowStart);
    // Require at least 5 requests before opening the circuit
    return windowRecords.length >= 5;
  }

  /**
   * Get remaining cooldown time in milliseconds.
   */
  private getCooldownRemaining(circuit: CircuitState, now: number): number {
    if (circuit.openedAt === null) {
      return 0;
    }
    const elapsed = now - circuit.openedAt;
    return Math.max(0, circuit.config.cooldown_ms - elapsed);
  }

  /**
   * Remove records older than the rolling window.
   */
  private pruneRecords(circuit: CircuitState, now: number): void {
    const windowStart = now - circuit.config.rolling_window_ms;
    circuit.records = circuit.records.filter((r) => r.timestamp > windowStart);
  }
}
