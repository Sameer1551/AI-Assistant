/**
 * Unit tests for TimeoutEnforcer.
 *
 * Verifies:
 * - Operations completing within timeout
 * - Operations exceeding timeout are terminated
 * - Timeout validation and clamping
 * - AbortSignal propagation
 *
 * @see Requirement 2.8 - Per-action timeout (1-600s, default 60s)
 */

import { describe, it, expect } from 'vitest';
import { TimeoutEnforcer, TimeoutError } from '../src/timeout-enforcer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a delayed operation that resolves after the specified ms.
 */
function createDelayedOperation<T>(result: T, delayMs: number) {
  return (signal: AbortSignal): Promise<T> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(result), delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      });
    });
  };
}

/**
 * Creates an operation that fails after the specified ms.
 */
function createFailingOperation(error: Error, delayMs: number) {
  return (_signal: AbortSignal): Promise<never> => {
    return new Promise((_, reject) => {
      setTimeout(() => reject(error), delayMs);
    });
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('TimeoutEnforcer', () => {
  // ─── Successful Execution ──────────────────────────────────────────────

  describe('successful execution within timeout', () => {
    it('should return completed result when operation finishes in time', async () => {
      const enforcer = new TimeoutEnforcer();
      const operation = createDelayedOperation('done', 10);

      const result = await enforcer.executeWithTimeout(operation, 5);

      expect(result.completed).toBe(true);
      expect(result.result).toBe('done');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('should return the operation result value', async () => {
      const enforcer = new TimeoutEnforcer();
      const operation = (_signal: AbortSignal) => Promise.resolve({ data: 42 });

      const result = await enforcer.executeWithTimeout(operation, 10);

      expect(result.completed).toBe(true);
      expect(result.result).toEqual({ data: 42 });
    });

    it('should measure elapsed time', async () => {
      const enforcer = new TimeoutEnforcer();
      const operation = createDelayedOperation('done', 50);

      const result = await enforcer.executeWithTimeout(operation, 5);

      expect(result.elapsed_ms).toBeGreaterThanOrEqual(40);
      expect(result.elapsed_ms).toBeLessThan(200);
    });
  });

  // ─── Timeout Enforcement ───────────────────────────────────────────────

  describe('timeout enforcement', () => {
    it('should return incomplete result when operation exceeds timeout', async () => {
      const enforcer = new TimeoutEnforcer();
      // Operation takes 5 seconds, timeout is 0.05 seconds (50ms)
      const operation = createDelayedOperation('never', 5000);

      const result = await enforcer.executeWithTimeout(operation, 0.05);

      expect(result.completed).toBe(false);
      expect(result.result).toBeUndefined();
    });

    it('should trigger AbortSignal on timeout', async () => {
      const enforcer = new TimeoutEnforcer();
      let signalAborted = false;

      const operation = (signal: AbortSignal): Promise<string> => {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            signalAborted = true;
          });
          setTimeout(() => resolve('done'), 5000);
        });
      };

      await enforcer.executeWithTimeout(operation, 0.05);

      expect(signalAborted).toBe(true);
    });

    it('should record elapsed time on timeout', async () => {
      const enforcer = new TimeoutEnforcer();
      const operation = createDelayedOperation('never', 5000);

      const result = await enforcer.executeWithTimeout(operation, 0.05);

      expect(result.elapsed_ms).toBeGreaterThanOrEqual(40);
    });
  });

  // ─── Error Propagation ─────────────────────────────────────────────────

  describe('error propagation', () => {
    it('should propagate non-timeout errors from the operation', async () => {
      const enforcer = new TimeoutEnforcer();
      const error = new Error('Operation failed');
      const operation = createFailingOperation(error, 10);

      await expect(
        enforcer.executeWithTimeout(operation, 5),
      ).rejects.toThrow('Operation failed');
    });

    it('should not treat operation errors as timeouts', async () => {
      const enforcer = new TimeoutEnforcer();
      const operation = (_signal: AbortSignal): Promise<never> => {
        return Promise.reject(new Error('Immediate failure'));
      };

      await expect(
        enforcer.executeWithTimeout(operation, 5),
      ).rejects.toThrow('Immediate failure');
    });
  });

  // ─── Timeout Validation ────────────────────────────────────────────────

  describe('validateTimeout', () => {
    it('should return default (60) for undefined', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(undefined)).toBe(60);
    });

    it('should return default for NaN', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(NaN)).toBe(60);
    });

    it('should return default for Infinity', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(Infinity)).toBe(60);
    });

    it('should clamp values below minimum (1) to minimum', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(0)).toBe(1);
      expect(enforcer.validateTimeout(-5)).toBe(1);
    });

    it('should clamp values above maximum (600) to maximum', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(700)).toBe(600);
      expect(enforcer.validateTimeout(1000)).toBe(600);
    });

    it('should accept values within range [1, 600]', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(1)).toBe(1);
      expect(enforcer.validateTimeout(60)).toBe(60);
      expect(enforcer.validateTimeout(300)).toBe(300);
      expect(enforcer.validateTimeout(600)).toBe(600);
    });

    it('should round fractional values', () => {
      const enforcer = new TimeoutEnforcer();
      expect(enforcer.validateTimeout(5.7)).toBe(6);
      expect(enforcer.validateTimeout(5.3)).toBe(5);
    });

    it('should use custom config when provided', () => {
      const enforcer = new TimeoutEnforcer({
        min_seconds: 5,
        max_seconds: 120,
        default_seconds: 30,
      });

      expect(enforcer.validateTimeout(undefined)).toBe(30);
      expect(enforcer.validateTimeout(3)).toBe(5);
      expect(enforcer.validateTimeout(200)).toBe(120);
      expect(enforcer.validateTimeout(60)).toBe(60);
    });
  });
});

// ─── TimeoutError ────────────────────────────────────────────────────────────

describe('TimeoutError', () => {
  it('should have correct name and message', () => {
    const error = new TimeoutError(60);
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe('Action exceeded timeout of 60 seconds');
    expect(error.timeoutSeconds).toBe(60);
  });

  it('should be an instance of Error', () => {
    const error = new TimeoutError(30);
    expect(error).toBeInstanceOf(Error);
  });
});
