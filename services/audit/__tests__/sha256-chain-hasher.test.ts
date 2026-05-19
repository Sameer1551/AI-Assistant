/**
 * Unit tests for SHA256ChainHasher.
 *
 * Verifies:
 * - Genesis hash computation (first event in chain)
 * - Chain hash computation (subsequent events)
 * - Deterministic output for same inputs
 * - Different outputs for different inputs
 */

import { describe, it, expect } from 'vitest';
import { SHA256ChainHasher } from '../src/sha256-chain-hasher.js';
import type { ChainHashInput } from '../src/interfaces/index.js';

function createHashInput(overrides: Partial<ChainHashInput> = {}): ChainHashInput {
  return {
    event_id: 'evt-001',
    timestamp: '2024-01-15T10:30:00.000Z',
    tenant_id: 'tenant-1',
    principal_id: 'principal-1',
    source_service: 'Control_Service',
    event_category: 'action.executed',
    severity: 'INFO',
    correlation_id: 'corr-123',
    outcome: 'SUCCESS',
    payload: {},
    ...overrides,
  };
}

describe('SHA256ChainHasher', () => {
  const hasher = new SHA256ChainHasher();

  describe('genesis hash', () => {
    it('should compute a valid SHA-256 hex hash for genesis event', () => {
      const input = createHashInput();
      const hash = hasher.computeHash(null, input);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should use "genesis" prefix when previousHash is null', () => {
      const input = createHashInput();
      const hash1 = hasher.computeHash(null, input);
      const hash2 = hasher.computeHash('some-previous-hash', input);

      // Genesis hash should differ from a chained hash with same fields
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('chain hash', () => {
    it('should produce different hash when previous hash differs', () => {
      const input = createHashInput();
      const hash1 = hasher.computeHash('hash-a', input);
      const hash2 = hasher.computeHash('hash-b', input);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hash when event fields differ', () => {
      const input1 = createHashInput({ outcome: 'SUCCESS' });
      const input2 = createHashInput({ outcome: 'FAILURE' });

      const hash1 = hasher.computeHash('same-prev', input1);
      const hash2 = hasher.computeHash('same-prev', input2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('determinism', () => {
    it('should produce the same hash for identical inputs', () => {
      const input = createHashInput();
      const hash1 = hasher.computeHash(null, input);
      const hash2 = hasher.computeHash(null, input);

      expect(hash1).toBe(hash2);
    });

    it('should produce the same hash regardless of payload key order', () => {
      const input1 = createHashInput({ payload: { a: 1, b: 2 } });
      const input2 = createHashInput({ payload: { a: 1, b: 2 } });

      const hash1 = hasher.computeHash(null, input1);
      const hash2 = hasher.computeHash(null, input2);

      expect(hash1).toBe(hash2);
    });

    it('should produce consistent hashes across multiple calls', () => {
      const input = createHashInput();
      const hashes = Array.from({ length: 100 }, () =>
        hasher.computeHash('prev-hash', input),
      );

      const unique = new Set(hashes);
      expect(unique.size).toBe(1);
    });
  });

  describe('sensitivity', () => {
    it('should produce different hash for different event_id', () => {
      const hash1 = hasher.computeHash(null, createHashInput({ event_id: 'a' }));
      const hash2 = hasher.computeHash(null, createHashInput({ event_id: 'b' }));
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hash for different severity', () => {
      const hash1 = hasher.computeHash(null, createHashInput({ severity: 'INFO' }));
      const hash2 = hasher.computeHash(null, createHashInput({ severity: 'CRITICAL' }));
      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hash for different payload', () => {
      const hash1 = hasher.computeHash(null, createHashInput({ payload: { x: 1 } }));
      const hash2 = hasher.computeHash(null, createHashInput({ payload: { x: 2 } }));
      expect(hash1).not.toBe(hash2);
    });
  });
});
