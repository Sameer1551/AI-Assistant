/**
 * Audit service-specific types.
 * Types that are internal to this service.
 */

/**
 * Configuration for the audit ingestion service.
 */
export interface AuditServiceConfig {
  /** Number of events per chain segment for signing (default: 1) */
  readonly segment_size: number;
  /** Maximum query result limit (default: 1000) */
  readonly max_query_limit: number;
  /** Minimum retention period in days (default: 365) */
  readonly min_retention_days: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_AUDIT_CONFIG: Readonly<AuditServiceConfig> = {
  segment_size: 1,
  max_query_limit: 1000,
  min_retention_days: 365,
};
