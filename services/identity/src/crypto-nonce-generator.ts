/**
 * @module crypto-nonce-generator
 * Cryptographically secure nonce generator using Node.js crypto module.
 *
 * Generates 32-byte (256-bit) random nonces encoded as hex strings (64 characters).
 * Uses crypto.randomBytes for cryptographic security.
 */

import { randomBytes } from 'node:crypto';
import type { INonceGenerator } from './interfaces/confirmation-challenge.js';

/**
 * Production nonce generator using crypto.randomBytes.
 * Generates 32-byte hex-encoded nonces suitable for Confirmation_Challenges.
 */
export class CryptoNonceGenerator implements INonceGenerator {
  private readonly byteLength: number;

  /**
   * @param byteLength - Number of random bytes to generate (default: 32)
   */
  constructor(byteLength = 32) {
    this.byteLength = byteLength;
  }

  /**
   * Generate a cryptographically random nonce.
   *
   * @returns A hex-encoded random nonce (32 bytes = 64 hex characters by default)
   */
  generate(): string {
    return randomBytes(this.byteLength).toString('hex');
  }
}
