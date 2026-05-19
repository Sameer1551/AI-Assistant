/**
 * Unit tests for TokenValidator — standalone validation pipeline.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenValidator } from '../src/token-validator.js';
import type {
  ITokenCrypto,
  ITokenStore,
  IClock,
  TokenClaims,
} from '../src/interfaces/index.js';
import type { TenantId, PrincipalId, SessionId, ISOTimestamp } from '@may/types';

// ─── Mock Implementations ────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentSeconds = 1700000000;

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): ISOTimestamp {
    return new Date(this.currentSeconds * 1000).toISOString() as ISOTimestamp;
  }

  advance(seconds: number): void {
    this.currentSeconds += seconds;
  }
}

class MockTokenCrypto implements ITokenCrypto {
  private readonly tokens: Map<string, Record<string, unknown>> = new Map();

  async sign(payload: Record<string, unknown>, _keyId: string): Promise<string> {
    const token = `jwt-${this.tokens.size + 1}`;
    this.tokens.set(token, payload);
    return token;
  }

  async verify(token: string): Promise<Record<string, unknown> | null> {
    return this.tokens.get(token) ?? null;
  }

  injectToken(token: string, payload: Record<string, unknown>): void {
    this.tokens.set(token, payload);
  }
}

class MockTokenStore implements ITokenStore {
  private readonly revoked: Set<string> = new Set();

  async storeRefreshToken(): Promise<void> { /* no-op */ }
  async getRefreshToken(): Promise<null> { return null; }
  async revokeToken(jti: string): Promise<void> { this.revoked.add(jti); }
  async isRevoked(jti: string): Promise<boolean> { return this.revoked.has(jti); }
  async revokeSession(): Promise<void> { /* no-op */ }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('TokenValidator', () => {
  let validator: TokenValidator;
  let clock: MockClock;
  let crypto: MockTokenCrypto;
  let tokenStore: MockTokenStore;

  const validClaims: Record<string, unknown> = {
    sub: 'principal-1' as PrincipalId,
    tenant_id: 'tenant-1' as TenantId,
    roles: ['End_User'],
    session_id: 'session-1' as SessionId,
    iat: 1700000000,
    exp: 1700003600, // 1 hour from iat
    aud: 'may-platform',
    jti: 'token-jti-1',
  };

  beforeEach(() => {
    clock = new MockClock();
    crypto = new MockTokenCrypto();
    tokenStore = new MockTokenStore();

    validator = new TokenValidator({ crypto, tokenStore, clock });
  });

  describe('validate', () => {
    it('should return valid for a properly signed, unexpired, unrevoked token with correct audience', async () => {
      crypto.injectToken('valid-token', validClaims);

      const result = await validator.validate('valid-token', 'may-platform');

      expect(result.valid).toBe(true);
      expect(result.claims).toBeDefined();
      expect(result.claims!.sub).toBe('principal-1');
      expect(result.claims!.tenant_id).toBe('tenant-1');
      expect(result.claims!.roles).toEqual(['End_User']);
    });

    it('should reject token with invalid signature', async () => {
      const result = await validator.validate('unknown-token', 'may-platform');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_SIGNATURE');
    });

    it('should reject token with wrong audience', async () => {
      crypto.injectToken('valid-token', validClaims);

      const result = await validator.validate('valid-token', 'wrong-audience');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('AUDIENCE_MISMATCH');
    });

    it('should reject expired token', async () => {
      crypto.injectToken('expired-token', {
        ...validClaims,
        exp: 1700000000 - 1, // Already expired
      });

      const result = await validator.validate('expired-token', 'may-platform');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('EXPIRED');
    });

    it('should reject revoked token', async () => {
      crypto.injectToken('revoked-token', validClaims);
      await tokenStore.revokeToken('token-jti-1');

      const result = await validator.validate('revoked-token', 'may-platform');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('REVOKED');
    });

    it('should reject token with malformed claims (missing required fields)', async () => {
      crypto.injectToken('malformed-token', {
        sub: 'principal-1',
        // Missing other required fields
      });

      const result = await validator.validate('malformed-token', 'may-platform');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('MALFORMED');
    });

    it('should check all four conditions in order (signature first)', async () => {
      // Token not in crypto store — signature check fails first
      const result = await validator.validate('no-such-token', 'may-platform');
      expect(result.reason).toBe('INVALID_SIGNATURE');
    });

    it('should check audience before expiry', async () => {
      crypto.injectToken('wrong-aud-expired', {
        ...validClaims,
        aud: 'other-service',
        exp: 1700000000 - 1, // Also expired
      });

      const result = await validator.validate('wrong-aud-expired', 'may-platform');
      expect(result.reason).toBe('AUDIENCE_MISMATCH');
    });

    it('should check expiry before revocation', async () => {
      crypto.injectToken('expired-revoked', {
        ...validClaims,
        exp: 1700000000 - 1, // Expired
      });
      await tokenStore.revokeToken('token-jti-1');

      const result = await validator.validate('expired-revoked', 'may-platform');
      expect(result.reason).toBe('EXPIRED');
    });
  });

  describe('validateAll', () => {
    it('should return all failures for a token with multiple issues', async () => {
      crypto.injectToken('multi-fail', {
        ...validClaims,
        aud: 'wrong-audience',
        exp: 1700000000 - 1, // Expired
        jti: 'revoked-jti',
      });
      await tokenStore.revokeToken('revoked-jti');

      const result = await validator.validateAll('multi-fail', 'may-platform');

      expect(result.valid).toBe(false);
      expect(result.failures).toContain('AUDIENCE_MISMATCH');
      expect(result.failures).toContain('EXPIRED');
      expect(result.failures).toContain('REVOKED');
    });

    it('should return empty failures array for valid token', async () => {
      crypto.injectToken('valid-token', validClaims);

      const result = await validator.validateAll('valid-token', 'may-platform');

      expect(result.valid).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.claims).toBeDefined();
    });
  });
});
