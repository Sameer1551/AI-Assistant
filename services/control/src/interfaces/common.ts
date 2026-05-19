/**
 * Common dependency interfaces shared across the control service.
 */

import type { ISOTimestamp } from '@may/types';

/**
 * Clock abstraction for testable time-dependent logic.
 */
export interface IClock {
  /** Returns the current time as Unix epoch seconds. */
  nowSeconds(): number;
  /** Returns the current time as an ISO 8601 timestamp string. */
  nowISO(): ISOTimestamp;
}

/**
 * ID generator for creating unique identifiers.
 */
export interface IIdGenerator {
  /** Generate a new UUID v4 string. */
  uuid(): string;
}
