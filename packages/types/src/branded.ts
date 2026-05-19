/**
 * @module branded
 * Branded types for domain-specific value constraints.
 *
 * Branded types provide compile-time safety by distinguishing semantically
 * different values that share the same runtime representation.
 */

/**
 * A unique symbol used to brand types, preventing accidental
 * assignment of plain values where a constrained type is expected.
 */
declare const __brand: unique symbol;

// ─── Numeric Branded Types ───────────────────────────────────────────────────

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

// ─── String Branded Types (Identity) ─────────────────────────────────────────

/**
 * A branded UUID string representing a Tenant identifier.
 * Establishes the cryptographic tenant boundary.
 */
export type TenantId = string & { readonly [__brand]: 'TenantId' };

/**
 * A branded UUID string representing an authenticated principal (user or service).
 */
export type PrincipalId = string & { readonly [__brand]: 'PrincipalId' };

/**
 * A branded UUID string used for distributed trace correlation across services.
 */
export type CorrelationId = string & { readonly [__brand]: 'CorrelationId' };

/**
 * A branded UUID string representing a current authentication session.
 */
export type SessionId = string & { readonly [__brand]: 'SessionId' };

/**
 * A branded UUID string representing a discrete Action.
 */
export type ActionId = string & { readonly [__brand]: 'ActionId' };

/**
 * A branded string representing a client-generated idempotency key for Actions.
 */
export type IdempotencyKey = string & { readonly [__brand]: 'IdempotencyKey' };

/**
 * A branded UUID string representing a Confirmation Challenge.
 */
export type ChallengeId = string & { readonly [__brand]: 'ChallengeId' };

/**
 * A branded string representing an ISO 8601 timestamp.
 */
export type ISOTimestamp = string & { readonly [__brand]: 'ISOTimestamp' };
