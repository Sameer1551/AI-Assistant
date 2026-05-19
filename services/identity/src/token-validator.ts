/**
 * @module token-validator
 * Standalone token validation logic.
 *
 * Provides a focused validation pipeline that checks ALL four required conditions:
 * 1. Signature validity (cryptographic verification)
 * 2. Audience match (token audience matches expected)
 * 3. Expiry check (token has not expired)
 * 4. Revocation status (token JTI not in revocation list)
 *
 * This module can be used independently of the full TokenService for
 * lightweight token validation in middleware or gateway contexts.
 *
 * @remarks
 * All dependencies are injected for testability and deployment flexibility.
 */

import type { ITokenCrypto, ITokenStore, IClock, TokenClaims, ValidationResult } from './interfaces/index.js';

/**
 * Validation failure reasons.
 */
export type ValidationFailureReason =
  | 'INVALID_SIGNATURE'
  | 'AUDIENCE_MISMATCH'
  | 'EXPIRED'
  | 'REVOKED'
  | 'MALFORMED';

/**
 * Dependencies required by the TokenValidator.
 */
export interface TokenValidatorDependencies {
  readonly crypto: ITokenCrypto;
  readonly tokenStore: ITokenStore;
  readonly clock: IClock;
}

/**
 * Standalone token validator that enforces all four validation checks.
 *
 * Designed for use in API gateways, middleware, and service-to-service
 * authentication where the full TokenService is not needed.
 *
 * @example
 * ```typescript
 * const validator = new TokenValidator({ crypto, tokenStore, clock });
 * const result = await validator.validate(token, 'may-platform');
 *
 * if (result.valid) {
 *   // Access result.claims
 * } else {
 *   // Handle result.reason
 * }
 * ```
 */
export class TokenValidator {
  private readonly crypto: ITokenCrypto;
  private readonly tokenStore: ITokenStore;
  private readonly clock: IClock;

  constructor(deps: TokenValidatorDependencies) {
    this.crypto = deps.crypto;
    this.tokenStore = deps.tokenStore;
    this.clock = deps.clock;
  }

  /**
   * Validate a token by checking signature, audience, expiry, and revocation.
   *
   * All four checks MUST pass for the token to be considered valid.
   * Checks are performed in order; the first failure short-circuits.
   *
   * @param token - The JWT string to validate
   * @param expectedAudience - The audience the token must be issued for
   * @returns Validation result with claims if valid, or failure reason
   */
  async validate(token: string, expectedAudience: string): Promise<ValidationResult> {
    // 1. Verify signature
    const payload = await this.crypto.verify(token);
    if (!payload) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    // Parse claims from payload
    const claims = this.extractClaims(payload);
    if (!claims) {
      return { valid: false, reason: 'MALFORMED' };
    }

    // 2. Validate audience
    if (claims.aud !== expectedAudience) {
      return { valid: false, reason: 'AUDIENCE_MISMATCH' };
    }

    // 3. Check expiry
    const now = this.clock.nowSeconds();
    if (claims.exp <= now) {
      return { valid: false, reason: 'EXPIRED' };
    }

    // 4. Check revocation status
    const isRevoked = await this.tokenStore.isRevoked(claims.jti);
    if (isRevoked) {
      return { valid: false, reason: 'REVOKED' };
    }

    return { valid: true, claims };
  }

  /**
   * Validate multiple conditions and return all failures (non-short-circuit).
   *
   * Useful for debugging and audit logging where you want to know
   * ALL reasons a token is invalid, not just the first.
   *
   * @param token - The JWT string to validate
   * @param expectedAudience - The audience the token must be issued for
   * @returns Object with validity status and array of all failure reasons
   */
  async validateAll(token: string, expectedAudience: string): Promise<{
    readonly valid: boolean;
    readonly claims?: TokenClaims;
    readonly failures: readonly ValidationFailureReason[];
  }> {
    const failures: ValidationFailureReason[] = [];

    // 1. Verify signature
    const payload = await this.crypto.verify(token);
    if (!payload) {
      // Cannot proceed without a valid payload
      return { valid: false, failures: ['INVALID_SIGNATURE'] };
    }

    // Parse claims
    const claims = this.extractClaims(payload);
    if (!claims) {
      return { valid: false, failures: ['MALFORMED'] };
    }

    // 2. Validate audience
    if (claims.aud !== expectedAudience) {
      failures.push('AUDIENCE_MISMATCH');
    }

    // 3. Check expiry
    const now = this.clock.nowSeconds();
    if (claims.exp <= now) {
      failures.push('EXPIRED');
    }

    // 4. Check revocation status
    const isRevoked = await this.tokenStore.isRevoked(claims.jti);
    if (isRevoked) {
      failures.push('REVOKED');
    }

    if (failures.length > 0) {
      return { valid: false, claims, failures };
    }

    return { valid: true, claims, failures: [] };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Extract and validate token claims from a decoded payload.
   */
  private extractClaims(payload: Record<string, unknown>): TokenClaims | null {
    const sub = payload['sub'];
    const tenant_id = payload['tenant_id'];
    const roles = payload['roles'];
    const session_id = payload['session_id'];
    const iat = payload['iat'];
    const exp = payload['exp'];
    const aud = payload['aud'];
    const jti = payload['jti'];

    if (
      typeof sub !== 'string' ||
      typeof tenant_id !== 'string' ||
      !Array.isArray(roles) ||
      typeof session_id !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      typeof aud !== 'string' ||
      typeof jti !== 'string'
    ) {
      return null;
    }

    return {
      sub: sub as TokenClaims['sub'],
      tenant_id: tenant_id as TokenClaims['tenant_id'],
      roles: roles as readonly string[],
      session_id: session_id as TokenClaims['session_id'],
      iat,
      exp,
      aud,
      jti,
    };
  }
}
