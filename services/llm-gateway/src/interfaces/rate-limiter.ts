/**
 * Rate limiter interfaces for the LLM Gateway.
 *
 * Implements per-tenant and per-principal rate limiting using a sliding window
 * algorithm. Returns RATE_LIMITED errors with Retry-After values when limits
 * are exceeded.
 *
 * @see Requirement 4.9 — per-Tenant and per-principal request rate limits
 */

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  readonly allowed: boolean;

  /** Remaining requests in the current window. */
  readonly remaining: number;

  /** Total limit for the window. */
  readonly limit: number;

  /** Milliseconds until the window resets (Retry-After value). */
  readonly retry_after_ms: number;

  /** The key that was rate-limited (for diagnostics). */
  readonly key: string;
}

/**
 * Configuration for a rate limit window.
 */
export interface RateLimitWindowConfig {
  /** Maximum number of requests allowed in the window. */
  readonly max_requests: number;

  /** Window duration in milliseconds. */
  readonly window_ms: number;
}

/**
 * Rate limiter interface for the LLM Gateway.
 *
 * Supports per-tenant and per-principal rate limiting with configurable
 * windows. Uses a sliding window algorithm to provide smooth rate limiting.
 *
 * @see Requirement 4.9 — per-Tenant and per-principal request rate limits
 */
export interface IRateLimiter {
  /**
   * Check if a request is allowed under the rate limit.
   * If allowed, consumes one request from the quota.
   *
   * @param tenantId - The tenant making the request
   * @param principalId - The principal (user) making the request
   * @returns Rate limit result indicating whether the request is allowed
   */
  checkLimit(tenantId: string, principalId: string): RateLimitResult;

  /**
   * Configure rate limits for a specific tenant.
   *
   * @param tenantId - The tenant to configure
   * @param tenantLimit - Rate limit for the entire tenant
   * @param principalLimit - Rate limit per principal within the tenant
   */
  configure(
    tenantId: string,
    tenantLimit: RateLimitWindowConfig,
    principalLimit: RateLimitWindowConfig,
  ): void;

  /**
   * Get the current rate limit status for a tenant/principal without consuming quota.
   *
   * @param tenantId - The tenant to check
   * @param principalId - The principal to check
   * @returns Current rate limit status
   */
  getStatus(tenantId: string, principalId: string): RateLimitResult;

  /**
   * Reset rate limit counters for a tenant (e.g., on configuration change).
   *
   * @param tenantId - The tenant to reset
   */
  reset(tenantId: string): void;
}
