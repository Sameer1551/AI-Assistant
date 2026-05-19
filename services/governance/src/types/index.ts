/**
 * Governance service-specific types.
 * Types that are internal to this service.
 */

/**
 * Summary of PII detections by category.
 * Used in redaction reports for aggregated counts.
 */
export interface PIICategorySummary {
  /** The PII category */
  readonly category: string;

  /** Number of detections in this category */
  readonly count: number;
}
