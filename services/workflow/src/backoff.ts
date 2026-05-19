/**
 * @module backoff
 * Exponential backoff computation for workflow retry.
 *
 * delay = initial_backoff_ms × backoff_multiplier^(attempt - 1)
 * Capped at max_backoff_ms.
 *
 * @see Requirement 8.4 — retry with exponential backoff
 */

import type { RetryPolicy } from '@may/types';

/**
 * Compute backoff delay for a given attempt number (1-indexed).
 *
 * @param policy - The retry policy configuration
 * @param attempt - The current attempt number (1 = first retry)
 * @returns Delay in milliseconds, capped at max_backoff_ms
 */
export function computeBackoffDelay(policy: RetryPolicy, attempt: number): number {
  const raw = policy.initial_backoff_ms * Math.pow(policy.backoff_multiplier, attempt - 1);
  return Math.min(raw, policy.max_backoff_ms);
}
