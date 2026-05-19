/**
 * @module jose-token-crypto
 * JWT signing and verification using the jose library.
 *
 * Implements the ITokenCrypto interface with:
 * - RS256 (RSA-PSS) or ES256 (ECDSA) signing algorithms
 * - Key rotation support via key ID (kid) in JWT header
 * - Configurable issuer claim injection
 *
 * This module uses the jose library for all cryptographic operations,
 * ensuring standards-compliant JWT handling.
 */

import { SignJWT, jwtVerify, importJWK, type JWK, type KeyLike } from 'jose';
import type { ITokenCrypto } from './interfaces/index.js';

/**
 * Configuration for the JoseTokenCrypto implementation.
 */
export interface JoseTokenCryptoConfig {
  /** The issuer claim to embed in all signed tokens. */
  readonly issuer: string;
  /** The signing algorithm (e.g., 'RS256', 'ES256', 'EdDSA'). */
  readonly algorithm: string;
  /** Map of key IDs to their JWK representations for signing. */
  readonly signingKeys: ReadonlyMap<string, JWK>;
  /** Map of key IDs to their JWK representations for verification (includes public keys). */
  readonly verificationKeys: ReadonlyMap<string, JWK>;
}

/**
 * Production implementation of ITokenCrypto using the jose library.
 *
 * Supports multiple signing keys for rotation. The active signing key
 * is selected by keyId parameter in the sign() method. Verification
 * uses the kid header from the JWT to select the correct public key.
 *
 * @remarks
 * Keys are imported lazily and cached for performance.
 */
export class JoseTokenCrypto implements ITokenCrypto {
  private readonly config: JoseTokenCryptoConfig;
  private readonly signingKeyCache: Map<string, KeyLike | Uint8Array> = new Map();
  private readonly verificationKeyCache: Map<string, KeyLike | Uint8Array> = new Map();

  constructor(config: JoseTokenCryptoConfig) {
    this.config = config;
  }

  /**
   * Sign a token payload and return the complete JWT string.
   *
   * @param payload - The claims to encode in the token
   * @param keyId - Identifier of the signing key to use
   * @returns The signed JWT string
   * @throws Error if the specified key ID is not found
   */
  async sign(payload: Record<string, unknown>, keyId: string): Promise<string> {
    const key = await this.getSigningKey(keyId);

    const jwt = new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({
        alg: this.config.algorithm,
        kid: keyId,
        typ: 'JWT',
      })
      .setIssuer(this.config.issuer);

    return jwt.sign(key);
  }

  /**
   * Verify a JWT signature and decode the payload.
   *
   * Extracts the kid from the JWT header to select the verification key.
   * Returns null if signature verification fails or the key is unknown.
   *
   * @param token - The JWT string to verify
   * @returns Decoded payload if signature is valid, null if invalid
   */
  async verify(token: string): Promise<Record<string, unknown> | null> {
    try {
      // Decode header to get kid without verifying first
      const headerB64 = token.split('.')[0];
      if (!headerB64) {
        return null;
      }

      const headerJson = Buffer.from(headerB64, 'base64url').toString('utf-8');
      const header = JSON.parse(headerJson) as { kid?: string; alg?: string };

      const kid = header.kid;
      if (!kid) {
        return null;
      }

      const key = await this.getVerificationKey(kid);
      if (!key) {
        return null;
      }

      const { payload } = await jwtVerify(token, key, {
        algorithms: [this.config.algorithm],
        issuer: this.config.issuer,
        // Expiry and audience are validated by the TokenValidator/TokenService layer,
        // not at the cryptographic verification level. This separation allows
        // the validator to report specific failure reasons.
        clockTolerance: Number.MAX_SAFE_INTEGER,
      });

      return payload as Record<string, unknown>;
    } catch {
      // Any verification failure returns null
      return null;
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private async getSigningKey(keyId: string): Promise<KeyLike | Uint8Array> {
    const cached = this.signingKeyCache.get(keyId);
    if (cached) {
      return cached;
    }

    const jwk = this.config.signingKeys.get(keyId);
    if (!jwk) {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    const key = await importJWK(jwk, this.config.algorithm);
    this.signingKeyCache.set(keyId, key);
    return key;
  }

  private async getVerificationKey(keyId: string): Promise<KeyLike | Uint8Array | null> {
    const cached = this.verificationKeyCache.get(keyId);
    if (cached) {
      return cached;
    }

    const jwk = this.config.verificationKeys.get(keyId);
    if (!jwk) {
      return null;
    }

    const key = await importJWK(jwk, this.config.algorithm);
    this.verificationKeyCache.set(keyId, key);
    return key;
  }
}
