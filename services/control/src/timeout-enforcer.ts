/**
 * Timeout enforcement for action execution.
 *
 * Ensures actions complete within their configured timeout. If an action
 * exceeds the timeout, it is terminated and marked with TIMEOUT outcome.
 *
 * @see Requirement 2.8 - Per-action timeout (1-600s, default 60s) with TIMEOUT outcome
 */

import type { ITimeoutEnforcer, TimeoutConfig, TimeoutResult } from './interfaces/index.js';

/** Default timeout configuration per Requirement 2.8. */
export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  min_seconds: 1,
  max_seconds: 600,
  default_seconds: 60,
};

/**
 * Enforces per-action timeout constraints using AbortController.
 *
 * When an action exceeds its configured timeout:
 * 1. The AbortSignal is triggered (allowing cooperative cancellation)
 * 2. The result indicates timeout occurred
 * 3. The elapsed time is recorded
 */
export class TimeoutEnforcer implements ITimeoutEnforcer {
  private readonly config: TimeoutConfig;

  /**
   * Creates a TimeoutEnforcer.
   *
   * @param config - Timeout configuration (defaults to 1-600s range, 60s default)
   * @param getNow - Optional clock function for testing
   */
  constructor(
    config: Partial<TimeoutConfig> = {},
    private readonly getNow: () => number = () => Date.now(),
  ) {
    this.config = { ...DEFAULT_TIMEOUT_CONFIG, ...config };
  }

  async executeWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutSeconds: number,
  ): Promise<TimeoutResult<T>> {
    const validatedTimeout = this.validateTimeout(timeoutSeconds);
    const timeoutMs = validatedTimeout * 1000;

    const controller = new AbortController();
    const startTime = this.getNow();

    // Create a timeout promise that rejects after the configured duration
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(validatedTimeout));
      }, timeoutMs);
    });

    try {
      // Race the operation against the timeout
      const result = await Promise.race([
        operation(controller.signal),
        timeoutPromise,
      ]);

      const elapsed = this.getNow() - startTime;

      return {
        completed: true,
        result,
        elapsed_ms: elapsed,
      };
    } catch (error) {
      const elapsed = this.getNow() - startTime;

      if (error instanceof TimeoutError) {
        return {
          completed: false,
          elapsed_ms: elapsed,
        };
      }

      // If the signal was aborted (timeout triggered), treat as timeout
      if (controller.signal.aborted) {
        return {
          completed: false,
          elapsed_ms: elapsed,
        };
      }

      // Re-throw non-timeout errors
      throw error;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  validateTimeout(timeoutSeconds: number | undefined): number {
    if (timeoutSeconds === undefined || timeoutSeconds === null) {
      return this.config.default_seconds;
    }

    if (!Number.isFinite(timeoutSeconds)) {
      return this.config.default_seconds;
    }

    // Clamp to valid range
    return Math.max(
      this.config.min_seconds,
      Math.min(this.config.max_seconds, Math.round(timeoutSeconds)),
    );
  }
}

/**
 * Error thrown when an action exceeds its timeout.
 * Used internally to distinguish timeout from other errors.
 */
export class TimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds: number) {
    super(`Action exceeded timeout of ${timeoutSeconds} seconds`);
    this.name = 'TimeoutError';
    this.timeoutSeconds = timeoutSeconds;
  }
}
