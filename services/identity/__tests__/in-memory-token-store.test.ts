/**
 * Unit tests for InMemoryTokenStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryTokenStore } from '../src/in-memory-token-store.js';
import type { RefreshTokenRecord } from '../src/interfaces/index.js';
import type { TenantId, PrincipalId, SessionId } from '@may/types';

function makeRecord(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    jti: 'jti-1',
    sub: 'principal-1' as PrincipalId,
    tenant_id: 'tenant-1' as TenantId,
    session_id: 'session-1' as SessionId,
    roles: ['End_User'],
    audience: 'may-platform',
    iat: 1700000000,
    exp: 1700086400,
    revoked: false,
    ...overrides,
  };
}

describe('InMemoryTokenStore', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    // Disable sweep for tests
    store = new InMemoryTokenStore(0);
  });

  afterEach(() => {
    store.dispose();
  });

  describe('storeRefreshToken', () => {
    it('should store and retrieve a refresh token record', async () => {
      const record = makeRecord();
      await store.storeRefreshToken('jti-1', record);

      const retrieved = await store.getRefreshToken('jti-1');
      expect(retrieved).toEqual(record);
    });

    it('should return null for non-existent token', async () => {
      const result = await store.getRefreshToken('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('revokeToken', () => {
    it('should mark a token as revoked', async () => {
      const record = makeRecord();
      await store.storeRefreshToken('jti-1', record);

      await store.revokeToken('jti-1');

      expect(await store.isRevoked('jti-1')).toBe(true);
    });

    it('should report non-revoked token as not revoked', async () => {
      const record = makeRecord();
      await store.storeRefreshToken('jti-1', record);

      expect(await store.isRevoked('jti-1')).toBe(false);
    });

    it('should handle revoking non-existent token gracefully', async () => {
      await store.revokeToken('non-existent');
      expect(await store.isRevoked('non-existent')).toBe(true);
    });
  });

  describe('revokeSession', () => {
    it('should revoke all tokens in a session', async () => {
      const sessionId = 'session-1' as SessionId;

      await store.storeRefreshToken('jti-1', makeRecord({ jti: 'jti-1', session_id: sessionId }));
      await store.storeRefreshToken('jti-2', makeRecord({ jti: 'jti-2', session_id: sessionId }));
      await store.storeRefreshToken('jti-3', makeRecord({ jti: 'jti-3', session_id: 'other-session' as SessionId }));

      await store.revokeSession(sessionId);

      expect(await store.isRevoked('jti-1')).toBe(true);
      expect(await store.isRevoked('jti-2')).toBe(true);
      expect(await store.isRevoked('jti-3')).toBe(false);
    });
  });

  describe('size and revokedCount', () => {
    it('should track stored token count', async () => {
      expect(store.size).toBe(0);

      await store.storeRefreshToken('jti-1', makeRecord({ jti: 'jti-1' }));
      expect(store.size).toBe(1);

      await store.storeRefreshToken('jti-2', makeRecord({ jti: 'jti-2' }));
      expect(store.size).toBe(2);
    });

    it('should track revoked token count', async () => {
      expect(store.revokedCount).toBe(0);

      await store.revokeToken('jti-1');
      expect(store.revokedCount).toBe(1);
    });
  });
});
