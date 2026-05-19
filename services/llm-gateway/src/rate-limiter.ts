/**
 * Sliding window rate limiter implementation.
 *
 * Implements per-tenant and per-principal rate limiting using a sliding window
 * algorithm. Each request is tracked with a timestamp, and the window slides
 * forward in time to provide smooth rate limiting without hard resets.
 *
 * @see Requirement 4.9 — per-Tenant and per-principal request rate limits
 *   with Retry-After value when limits are exceeded
 */

import type {
  IRateLimiter,
  RateLimitResult,
  RateLimitWindowConfig,
} from './interfaces/rate-limiter.js';
import type { IClock } from './interfaces/index.js';

/**
 * Internal state for a single rate limit window.
 */
interface WindowState {
  /** Timestamps of requests within the current window. */
  timestamps: number[];
  /** Configuration for this window. */
  config: RateLimitWindowConfig;
}

/**
 * Default rate limit configuration.
 * 60 requests per minute for tenants, 20 per minute for principals.
 */
const DEFAULT_TENANT_LIMIT: RateLimitWindowConfig = {
  max_requests: 60,
  window_ms: 60_000,
};

const DEFAULT_PRINCIPAL_LIMIT: RateLimitWindowConfig = {
  max_requests: 20,
  window_ms: 60_000,
};

/**
 * Sliding window rate limiter.
 *
 * Maintains separate windows for tenant-level and principal-level limits.
 * A request must pass both checks to be allowed. When either limit is
 * exceeded, the response includes a Retry-After value indicating when
 * the next request will be allowed.
 *
 * @see Requirement 4.9 — per-Tenant and per-principal request rate limits
 */
export class RateLimiter implements IRateLimiter {
  /** Tenant-level rate limit windows. Key: tenantId */
  private readonly tenantWindows = new Map<string, WindowState>();

  /** Principal-level rate limit windows. Key: `${tenantId}:${principalId}` */
  private readonly principalWindows = new Map<string, WindowState>();

  /** Configured limits per tenant. Key: tenantId */
  private readonly tenantConfigs = new Map<string, {
    tenant: RateLimitWindowConfig;
    principal: RateLimitWindowConfig;
  }>();

  constructor(private readonly clock: IClock) {}

  checkLimit(tenantId: string, principalId: string): RateLimitResult {
    const now = this.nowMs();

    // Check tenant-level limit
    const tenantResult = this.checkWindow(
      this.getOrCreateTenantWindow(tenantId),
      now,
      `tenant:${tenantId}`,
    );

    if (!tenantResult.allowed) {
      return tenantResult;
    }

    // Check principal-level limit
    const principalKey = `${tenantId}:${principalId}`;
    const principalResult = this.checkWindow(
      this.getOrCreatePrincipalWindow(tenantId, principalId),
      now,
      `principal:${principalKey}`,
    );

    if (!principalResult.allowed) {
      return principalResult;
    }

    // Both passed — consume quota from both windows
    this.consumeFromWindow(this.getOrCreateTenantWindow(tenantId), now);
    this.consumeFromWindow(this.getOrCreatePrincipalWindow(tenantId, principalId), now);

    // Return the more restrictive remaining count
    const remaining = Math.min(tenantResult.remaining - 1, principalResult.remaining - 1);
    const limit = Math.min(tenantResult.limit, principalResult.limit);

    return {
      allowed: true,
      remaining: Math.max(0, remaining),
      limit,
      retry_after_ms: 0,
      key: `principal:${principalKey}`,
    };
  }

  configure(
    tenantId: string,
    tenantLimit: RateLimitWindowConfig,
    principalLimit: RateLimitWindowConfig,
  ): void {
    this.tenantConfigs.set(tenantId, {
      tenant: tenantLimit,
      principal: principalLimit,
    });

    // Update existing windows with new config
    const tenantWindow = this.tenantWindows.get(tenantId);
    if (tenantWindow) {
      tenantWindow.config = tenantLimit;
    }

    // Update all principal windows for this tenant
    for (const [key, window] of this.principalWindows.entries()) {
      if (key.startsWith(`${tenantId}:`)) {
        window.config = principalLimit;
      }
    }
  }

  getStatus(tenantId: string, principalId: string): RateLimitResult {
    const now = this.nowMs();
    const principalKey = `${tenantId}:${principalId}`;

    const tenantWindow = this.getOrCreateTenantWindow(tenantId);
    const principalWindow = this.getOrCreatePrincipalWindow(tenantId, principalId);

    const tenantResult = this.checkWindow(tenantWindow, now, `tenant:${tenantId}`);
    const principalResult = this.checkWindow(principalWindow, now, `principal:${principalKey}`);

    // Return the more restrictive result
    if (!tenantResult.allowed) {
      return tenantResult;
    }
    if (!principalResult.allowed) {
      return principalResult;
    }

    return {
      allowed: true,
      remaining: Math.min(tenantResult.remaining, principalResult.remaining),
      limit: Math.min(tenantResult.limit, principalResult.limit),
      retry_after_ms: 0,
      key: `principal:${principalKey}`,
    };
  }

  reset(tenantId: string): void {
    this.tenantWindows.delete(tenantId);

    // Remove all principal windows for this tenant
    for (const key of this.principalWindows.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.principalWindows.delete(key);
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private nowMs(): number {
    return new Date(this.clock.nowISO()).getTime();
  }

  private getOrCreateTenantWindow(tenantId: string): WindowState {
    let window = this.tenantWindows.get(tenantId);
    if (!window) {
      const config = this.tenantConfigs.get(tenantId)?.tenant ?? DEFAULT_TENANT_LIMIT;
      window = { timestamps: [], config };
      this.tenantWindows.set(tenantId, window);
    }
    return window;
  }

  private getOrCreatePrincipalWindow(tenantId: string, principalId: string): WindowState {
    const key = `${tenantId}:${principalId}`;
    let window = this.principalWindows.get(key);
    if (!window) {
      const config = this.tenantConfigs.get(tenantId)?.principal ?? DEFAULT_PRINCIPAL_LIMIT;
      window = { timestamps: [], config };
      this.principalWindows.set(key, window);
    }
    return window;
  }

  /**
   * Check if a request would be allowed in the given window without consuming quota.
   */
  private checkWindow(window: WindowState, now: number, key: string): RateLimitResult {
    // Prune expired timestamps
    const windowStart = now - window.config.window_ms;
    window.timestamps = window.timestamps.filter((ts) => ts > windowStart);

    const currentCount = window.timestamps.length;
    const remaining = window.config.max_requests - currentCount;

    if (remaining <= 0) {
      // Calculate retry-after: time until the oldest request in the window expires
      const oldestInWindow = window.timestamps[0];
      const retryAfter = oldestInWindow
        ? (oldestInWindow + window.config.window_ms) - now
        : window.config.window_ms;

      return {
        allowed: false,
        remaining: 0,
        limit: window.config.max_requests,
        retry_after_ms: Math.max(1, Math.ceil(retryAfter)),
        key,
      };
    }

    return {
      allowed: true,
      remaining,
      limit: window.config.max_requests,
      retry_after_ms: 0,
      key,
    };
  }

  /**
   * Consume one request from the window quota.
   */
  private consumeFromWindow(window: WindowState, now: number): void {
    window.timestamps.push(now);
  }
}
