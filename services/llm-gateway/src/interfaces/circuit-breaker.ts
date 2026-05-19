/**
 * Circuit breaker interfaces for the LLM Gateway.
 *
 * Implements the circuit breaker pattern for model providers with three states:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Requests are rejected immediately (error rate exceeded threshold)
 * - HALF_OPEN: Limited requests allowed to test recovery
 *
 * @see Requirement 4.10 — open circuit breaker when error rate exceeds threshold
 */

/**
 * Circuit breaker state.
 */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

/**
 * Result of a circuit breaker check.
 */
export interface CircuitBreakerCheckResult {
  /** Whether the request is allowed through the circuit. */
  readonly allowed: boolean;

  /** Current state of the circuit breaker. */
  readonly state: CircuitBreakerState;

  /** Current error rate in the rolling window (0.0 - 1.0). */
  readonly error_rate: number;

  /** The model whose circuit was checked. */
  readonly model_id: string;

  /** Milliseconds until the circuit breaker transitions (cooldown remaining). */
  readonly cooldown_remaining_ms: number;
}

/**
 * Configuration for a circuit breaker instance.
 */
export interface CircuitBreakerInstanceConfig {
  /** Error rate threshold (0-100) that triggers the circuit to open. */
  readonly error_threshold: number;

  /** Rolling window duration in milliseconds for error rate calculation. */
  readonly rolling_window_ms: number;

  /** Cooldown duration in milliseconds before transitioning from OPEN to HALF_OPEN. */
  readonly cooldown_ms: number;

  /**
   * Number of trial requests allowed in HALF_OPEN state.
   * If all succeed, the circuit closes. If any fail, it reopens.
   */
  readonly half_open_max_requests: number;
}

/**
 * Circuit breaker interface for the LLM Gateway.
 *
 * Manages per-model circuit breakers that prevent cascading failures
 * by stopping requests to unhealthy model providers.
 *
 * State transitions:
 * - CLOSED → OPEN: When error rate exceeds threshold in rolling window
 * - OPEN → HALF_OPEN: After cooldown duration expires
 * - HALF_OPEN → CLOSED: When trial requests succeed
 * - HALF_OPEN → OPEN: When a trial request fails
 *
 * @see Requirement 4.10 — circuit breaker per model with configurable threshold, window, cooldown
 */
export interface ICircuitBreaker {
  /**
   * Check if a request to the given model is allowed.
   *
   * @param modelId - The model to check
   * @returns Circuit breaker check result
   */
  canRequest(modelId: string): CircuitBreakerCheckResult;

  /**
   * Record a successful request to a model.
   * In HALF_OPEN state, may transition to CLOSED if enough successes.
   *
   * @param modelId - The model that succeeded
   */
  recordSuccess(modelId: string): void;

  /**
   * Record a failed request to a model.
   * May transition from CLOSED to OPEN if error rate exceeds threshold.
   * In HALF_OPEN state, transitions back to OPEN.
   *
   * @param modelId - The model that failed
   */
  recordFailure(modelId: string): void;

  /**
   * Configure the circuit breaker for a specific model.
   *
   * @param modelId - The model to configure
   * @param config - Circuit breaker configuration
   */
  configure(modelId: string, config: CircuitBreakerInstanceConfig): void;

  /**
   * Get the current state of a model's circuit breaker.
   *
   * @param modelId - The model to check
   * @returns Current circuit breaker state and metrics
   */
  getState(modelId: string): CircuitBreakerCheckResult;

  /**
   * Force-reset a circuit breaker to CLOSED state.
   * Used for manual recovery or testing.
   *
   * @param modelId - The model to reset
   */
  reset(modelId: string): void;
}
