/**
 * Chain segment signer implementation.
 *
 * Signs chain segments using HMAC-SHA256 with keys retrieved from
 * the Secrets_Service. Provides non-repudiation for audit chain segments.
 *
 * @see Requirement 21.3 - Chain segment signing using Secrets_Service keys
 */

import { createHmac } from 'node:crypto';
import type { IChainSigner } from './interfaces/index.js';

/**
 * Interface for retrieving signing keys from the Secrets_Service.
 * Decouples the chain signer from the full Secrets_Service interface.
 */
export interface ISigningKeyProvider {
  /**
   * Retrieves the current signing key for a tenant's audit chain.
   *
   * @param tenantId - The tenant identifier
   * @returns The signing key material (base64-encoded)
   */
  getSigningKey(tenantId: string): Promise<string>;
}

/**
 * HMAC-SHA256 chain segment signer.
 *
 * Signs concatenated chain hashes using a tenant-specific key
 * retrieved from the Secrets_Service via the ISigningKeyProvider.
 */
export class HMACChainSigner implements IChainSigner {
  constructor(private readonly keyProvider: ISigningKeyProvider) {}

  /**
   * Signs a chain segment by computing HMAC-SHA256 over the
   * concatenated chain hashes.
   *
   * @param tenantId - The tenant whose chain segment to sign
   * @param chainHashes - Ordered array of chain hashes to sign
   * @returns The HMAC signature (hex-encoded)
   */
  async sign(tenantId: string, chainHashes: readonly string[]): Promise<string> {
    const key = await this.keyProvider.getSigningKey(tenantId);
    const data = chainHashes.join('');

    return createHmac('sha256', Buffer.from(key, 'base64'))
      .update(data, 'utf8')
      .digest('hex');
  }

  /**
   * Verifies a chain segment signature by recomputing the HMAC
   * and comparing with the provided signature.
   *
   * @param tenantId - The tenant whose chain segment to verify
   * @param chainHashes - Ordered array of chain hashes that were signed
   * @param signature - The signature to verify (hex-encoded)
   * @returns True if the signature is valid
   */
  async verify(
    tenantId: string,
    chainHashes: readonly string[],
    signature: string,
  ): Promise<boolean> {
    const expected = await this.sign(tenantId, chainHashes);
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== signature.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
  }
}
