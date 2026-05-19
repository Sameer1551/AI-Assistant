/**
 * @module branded
 * Branded numeric types for domain-specific value constraints.
 *
 * Branded types provide compile-time safety by distinguishing semantically
 * different numeric values that share the same runtime representation.
 */

/**
 * A unique symbol used to brand numeric types, preventing accidental
 * assignment of plain numbers where a constrained score is expected.
 */
declare const __brand: unique symbol;

/**
 * A branded type that represents a numeric value constrained to the range [0.0, 1.0].
 * Used for confidence scores, probabilities, and normalized weights throughout the platform.
 *
 * @example
 * ```typescript
 * const score = 0.85 as UnitScore;
 * ```
 */
export type UnitScore = number & { readonly [__brand]: 'UnitScore' };

/**
 * Type guard that validates whether a number falls within the [0.0, 1.0] range.
 *
 * @param value - The number to validate
 * @returns True if the value is a valid UnitScore
 */
export function isUnitScore(value: number): value is UnitScore {
  return value >= 0.0 && value <= 1.0;
}

/**
 * Creates a UnitScore from a number, throwing if the value is out of range.
 *
 * @param value - The number to convert
 * @returns The value as a branded UnitScore
 * @throws RangeError if value is not in [0.0, 1.0]
 */
export function toUnitScore(value: number): UnitScore {
  if (!isUnitScore(value)) {
    throw new RangeError(`UnitScore must be in [0.0, 1.0], received: ${value}`);
  }
  return value;
}
