/**
 * SHA-256 chain hasher implementation.
 *
 * Computes cryptographic chain hashes linking each audit event to the
 * previous event in the tenant's chain, enabling tamper detection.
 *
 * @see Requirement 21.2 - SHA-256 chain hash linking events
 */

import { createHash } from 'node:crypto';
import type { IChainHasher, ChainHashInput } from './interfaces/index.js';

/** The genesis prefix used for the first event in a tenant's chain. */
const GENESIS_PREFIX = 'genesis';

/**
 * SHA-256 chain hasher using Node.js crypto module.
 *
 * Hash computation:
 * - First event: SHA-256("genesis" + serialized_event_fields)
 * - Subsequent events: SHA-256(previous_chain_hash + serialized_event_fields)
 *
 * Serialization uses deterministic JSON (sorted keys) to ensure
 * consistent hash computation regardless of field insertion order.
 */
export class SHA256ChainHasher implements IChainHasher {
  /**
   * Computes the chain hash for an event.
   *
   * @param previousHash - The chain_hash of the previous event, or null for genesis
   * @param eventFields - The event fields to include in the hash
   * @returns The computed SHA-256 hex hash
   */
  computeHash(previousHash: string | null, eventFields: ChainHashInput): string {
    const prefix = previousHash ?? GENESIS_PREFIX;
    const serialized = this.serializeFields(eventFields);
    const input = prefix + serialized;

    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  /**
   * Serializes event fields deterministically for hash computation.
   * Uses JSON.stringify with a replacer that sorts keys at all levels
   * to ensure consistent ordering regardless of insertion order.
   */
  private serializeFields(fields: ChainHashInput): string {
    return JSON.stringify(fields, (_key, value) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return value as unknown;
    });
  }
}
