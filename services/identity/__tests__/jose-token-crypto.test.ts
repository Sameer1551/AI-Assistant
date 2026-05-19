/**
 * Unit tests for JoseTokenCrypto — real JWT signing and verification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { JoseTokenCrypto, type JoseTokenCryptoConfig } from '../src/jose-token-crypto.js';

describe('JoseTokenCrypto', () => {
  let crypto: JoseTokenCrypto;
  let privateJwk: JWK;
  let publicJwk: JWK;

  beforeEach(async () => {
    // Generate an ES256 key pair for testing
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    privateJwk = await exportJWK(privateKey);
    publicJwk = await exportJWK(publicKey);

    const signingKeys = new Map<string, JWK>();
    signingKeys.set('key-1', privateJwk);

    const verificationKeys = new Map<string, JWK>();
    verificationKeys.set('key-1', publicJwk);

    const config: JoseTokenCryptoConfig = {
      issuer: 'https://identity.may-platform.local',
      algorithm: 'ES256',
      signingKeys,
      verificationKeys,
    };

    crypto = new JoseTokenCrypto(config);
  });

  describe('sign', () => {
    it('should produce a valid JWT string', async () => {
      const payload = {
        sub: 'principal-1',
        tenant_id: 'tenant-1',
        roles: ['End_User'],
        session_id: 'session-1',
        iat: 1700000000,
        exp: 1700003600,
        aud: 'may-platform',
        jti: 'token-1',
      };

      const token = await crypto.sign(payload, 'key-1');

      // JWT has 3 parts separated by dots
      expect(token.split('.')).toHaveLength(3);
    });

    it('should throw when signing key is not found', async () => {
      await expect(
        crypto.sign({ sub: 'test' }, 'non-existent-key'),
      ).rejects.toThrow('Signing key not found: non-existent-key');
    });
  });

  describe('verify', () => {
    it('should verify and decode a token signed with the same key', async () => {
      const payload = {
        sub: 'principal-1',
        tenant_id: 'tenant-1',
        roles: ['End_User'],
        session_id: 'session-1',
        iat: 1700000000,
        exp: 1700003600,
        aud: 'may-platform',
        jti: 'token-1',
      };

      const token = await crypto.sign(payload, 'key-1');
      const decoded = await crypto.verify(token);

      expect(decoded).not.toBeNull();
      expect(decoded!['sub']).toBe('principal-1');
      expect(decoded!['tenant_id']).toBe('tenant-1');
      expect(decoded!['roles']).toEqual(['End_User']);
      expect(decoded!['jti']).toBe('token-1');
    });

    it('should return null for a tampered token', async () => {
      const payload = {
        sub: 'principal-1',
        iat: 1700000000,
        exp: 1700003600,
        aud: 'may-platform',
        jti: 'token-1',
      };

      const token = await crypto.sign(payload, 'key-1');

      // Tamper with the payload
      const parts = token.split('.');
      parts[1] = parts[1]! + 'tampered';
      const tamperedToken = parts.join('.');

      const result = await crypto.verify(tamperedToken);
      expect(result).toBeNull();
    });

    it('should return null for a completely invalid token', async () => {
      const result = await crypto.verify('not-a-jwt');
      expect(result).toBeNull();
    });

    it('should return null for a token with unknown kid', async () => {
      // Create a different crypto instance with a different key
      const { privateKey: otherPrivate, publicKey: otherPublic } = await generateKeyPair('ES256');
      const otherPrivateJwk = await exportJWK(otherPrivate);
      const otherPublicJwk = await exportJWK(otherPublic);

      const otherSigningKeys = new Map<string, JWK>();
      otherSigningKeys.set('other-key', otherPrivateJwk);

      const otherVerificationKeys = new Map<string, JWK>();
      otherVerificationKeys.set('other-key', otherPublicJwk);

      const otherCrypto = new JoseTokenCrypto({
        issuer: 'https://identity.may-platform.local',
        algorithm: 'ES256',
        signingKeys: otherSigningKeys,
        verificationKeys: otherVerificationKeys,
      });

      // Sign with the other key
      const token = await otherCrypto.sign({ sub: 'test', iat: 1700000000, exp: 1700003600 }, 'other-key');

      // Try to verify with the original crypto (doesn't have 'other-key')
      const result = await crypto.verify(token);
      expect(result).toBeNull();
    });
  });

  describe('key rotation', () => {
    it('should support multiple signing keys', async () => {
      const { privateKey: key2Private, publicKey: key2Public } = await generateKeyPair('ES256');
      const key2PrivateJwk = await exportJWK(key2Private);
      const key2PublicJwk = await exportJWK(key2Public);

      const signingKeys = new Map<string, JWK>();
      signingKeys.set('key-1', privateJwk);
      signingKeys.set('key-2', key2PrivateJwk);

      const verificationKeys = new Map<string, JWK>();
      verificationKeys.set('key-1', publicJwk);
      verificationKeys.set('key-2', key2PublicJwk);

      const multiKeyCrypto = new JoseTokenCrypto({
        issuer: 'https://identity.may-platform.local',
        algorithm: 'ES256',
        signingKeys,
        verificationKeys,
      });

      // Sign with key-1
      const token1 = await multiKeyCrypto.sign({ sub: 'test1', iat: 1700000000, exp: 1700003600 }, 'key-1');
      // Sign with key-2
      const token2 = await multiKeyCrypto.sign({ sub: 'test2', iat: 1700000000, exp: 1700003600 }, 'key-2');

      // Both should verify
      const decoded1 = await multiKeyCrypto.verify(token1);
      const decoded2 = await multiKeyCrypto.verify(token2);

      expect(decoded1!['sub']).toBe('test1');
      expect(decoded2!['sub']).toBe('test2');
    });
  });
});
