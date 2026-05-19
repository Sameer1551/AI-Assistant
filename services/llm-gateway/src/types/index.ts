/**
 * LLM Gateway service-specific types.
 * Types that are internal to this service.
 */

/**
 * Internal versioned wrapper for model registry entries.
 * Tracks version history for auditing and rollback.
 */
export interface VersionedEntry<T> {
  /** The current entry data. */
  readonly current: T;
  /** Monotonically increasing version number. */
  readonly version_number: number;
}

/**
 * Error codes specific to the LLM Gateway service.
 */
export type LlmGatewayErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_ALREADY_EXISTS'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVOCATION_TIMEOUT'
  | 'INVOCATION_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONTENT_POLICY_VIOLATION'
  | 'CIRCUIT_BREAKER_OPEN';
