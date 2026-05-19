/**
 * Property-based tests for token lifetime and validation.
 *
 * **Validates: Requirements 11.2, 11.3**
 *
 * Property 34: Token Lifetime Constraints — access token ≤60min, refresh ≤24h
 * Property 35: Token Validation Completeness — all checks (signature, audience, expiry, revocation) must pass
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@may/testing';
import { TokenService } from '../../src/token-service.js';
import type {
  ITokenCrypto,
  ITokenStore,
  IOIDCClient,
  IPrincipalResolver,
  IClock,
  IIdGenerator,
  TokenConfig,
  RefreshTokenRecord,
  TokenValidationRequest,
  OIDCValidationResult,
  ResolvedPrincipal,
} from '../../src/interfaces/index.js';
import type { TenantId, PrincipalId, SessionId, CorrelationId, ISOTimestamp } from '@may/types';

// ─── Stub Implementations ────────────────────────────────────────────────────

class StubClock implements IClock {
  constructor(private currentSeconds: number = 1700000000) {}

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

class StubIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `id-${this.counter}`;
  }
}

/**
 * A token crypto stub that stores signed payloads in memory.
 * Can be configured to return null on verify to simulate invalid signatures.
 */
class StubTokenCrypto implements ITokenCrypto {
  private readonly tokens: Map<string, Record<string, unknown>> = new Map();
  private tokenCounter = 0;
  private shouldVerifyFail = false;

  async sign(payload: Record<string, unknown>, _keyId: string): Promise<string> {
    this.tokenCounter++;
    const token = `token-${this.tokenCounter}`;
    this.tokens.set(token, { ...payload });
    return token;
  }

  async verify(token: string): Promise<Record<string, unknown> | null> {
    if (this.shouldVerifyFail) return null;
    return this.tokens.get(token) ?? null;
  }

  setVerifyFail(fail: boolean): void {
    this.shouldVerifyFail = fail;
  }

  /** Inject a token payload for testing */
  injectToken(token: string, payload: Record<string, unknown>): void {
    this.tokens.set(token, payload);
  }
}

class StubTokenStore implements ITokenStore {
  private readonly records: Map<string, RefreshTokenRecord> = new Map();
  private readonly revoked: Set<string> = new Set();

  async storeRefreshToken(jti: string, record: RefreshTokenRecord): Promise<void> {
    this.records.set(jti, record);
  }

  async getRefreshToken(jti: string): Promise<RefreshTokenRecord | null> {
    return this.records.get(jti) ?? null;
  }

  async revokeToken(jti: string): Promise<void> {
    this.revoked.add(jti);
  }

  async isRevoked(jti: string): Promise<boolean> {
    return this.revoked.has(jti);
  }

  async revokeSession(_sessionId: SessionId): Promise<void> {
    // no-op
  }
}

class StubOIDCClient implements IOIDCClient {
  async validateExternalToken(_idToken: string, _tenantId: TenantId): Promise<OIDCValidationResult | null> {
    return null;
  }
}

class StubPrincipalResolver implements IPrincipalResolver {
  private principal: ResolvedPrincipal;

  constructor(principalId: string = 'principal-1', roles: string[] = ['End_User']) {
    this.principal = {
      principal_id: principalId as PrincipalId,
      roles,
    };
  }

  async resolve(_externalSub: string, _tenantId: TenantId): Promise<ResolvedPrincipal | null> {
    return this.principal;
  }

  async resolveCredentials(_username: string, _password: string, _tenantId: TenantId): Promise<ResolvedPrincipal | null> {
    return this.principal;
  }

  async resolveClientCredentials(_clientId: string, _clientSecret: string, _tenantId: TenantId): Promise<ResolvedPrincipal | null> {
    return this.principal;
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for access token lifetime in a wide range including values above the max. */
const accessTokenLifetimeArb = fc.integer({ min: 1, max: 100000 });

/** Arbitrary for refresh token lifetime in a wide range including values above the max. */
const refreshTokenLifetimeArb = fc.integer({ min: 1, max: 200000 });

/** Arbitrary for a TokenConfig with variable lifetimes. */
const tokenConfigArb = fc.record({
  accessTokenLifetimeSeconds: accessTokenLifetimeArb,
  refreshTokenLifetimeSeconds: refreshTokenLifetimeArb,
  signingKeyId: fc.constant('key-1'),
  defaultAudience: fc.constant('may-platform'),
});

/** Arbitrary for audience strings. */
const audienceArb = fc.stringOf(fc.char(), { minLength: 1, maxLength: 50 });

// ─── Property 34: Token Lifetime Constraints ─────────────────────────────────

describe('Property 34: Token Lifetime Constraints', () => {
  /**
   * **Validates: Requirements 11.2**
   *
   * For ANY valid TokenConfig with accessTokenLifetimeSeconds in [1, 100000]
   * and refreshTokenLifetimeSeconds in [1, 200000], the issued access token's
   * (exp - iat) MUST be ≤3600 seconds and the refresh token's (exp - iat)
   * MUST be ≤86400 seconds.
   */
  it('access token lifetime is always ≤ 3600 seconds regardless of config', async () => {
    await fc.assert(
      fc.asyncProperty(tokenConfigArb, async (config) => {
        const clock = new StubClock();
        const crypto = new StubTokenCrypto();
        const tokenStore = new StubTokenStore();
        const idGenerator = new StubIdGenerator();

        const service = new TokenService({
          crypto,
          tokenStore,
          oidcClient: new StubOIDCClient(),
          principalResolver: new StubPrincipalResolver(),
          clock,
          idGenerator,
          config,
        });

        const response = await service.authenticate({
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-1' as CorrelationId,
          grant_type: 'password',
          username: 'user',
          password: 'pass',
          audience: 'may-platform',
        });

        // The reported expires_in must be ≤ 3600
        expect(response.expires_in).toBeLessThanOrEqual(3600);
        expect(response.expires_in).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('refresh token lifetime is always ≤ 86400 seconds regardless of config', async () => {
    await fc.assert(
      fc.asyncProperty(tokenConfigArb, async (config) => {
        const clock = new StubClock();
        const crypto = new StubTokenCrypto();
        const tokenStore = new StubTokenStore();
        const idGenerator = new StubIdGenerator();

        const service = new TokenService({
          crypto,
          tokenStore,
          oidcClient: new StubOIDCClient(),
          principalResolver: new StubPrincipalResolver(),
          clock,
          idGenerator,
          config,
        });

        const response = await service.authenticate({
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-1' as CorrelationId,
          grant_type: 'password',
          username: 'user',
          password: 'pass',
          audience: 'may-platform',
        });

        // The reported refresh_expires_in must be ≤ 86400
        expect(response.refresh_expires_in).toBeLessThanOrEqual(86400);
        expect(response.refresh_expires_in).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('actual token claims (exp - iat) respect the lifetime constraints', async () => {
    await fc.assert(
      fc.asyncProperty(tokenConfigArb, async (config) => {
        const clock = new StubClock();
        const crypto = new StubTokenCrypto();
        const tokenStore = new StubTokenStore();
        const idGenerator = new StubIdGenerator();

        const service = new TokenService({
          crypto,
          tokenStore,
          oidcClient: new StubOIDCClient(),
          principalResolver: new StubPrincipalResolver(),
          clock,
          idGenerator,
          config,
        });

        const response = await service.authenticate({
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-1' as CorrelationId,
          grant_type: 'password',
          username: 'user',
          password: 'pass',
          audience: 'may-platform',
        });

        // Validate the access token claims directly
        const accessPayload = await crypto.verify(response.access_token);
        expect(accessPayload).not.toBeNull();
        const accessExp = accessPayload!['exp'] as number;
        const accessIat = accessPayload!['iat'] as number;
        expect(accessExp - accessIat).toBeLessThanOrEqual(3600);
        expect(accessExp - accessIat).toBeGreaterThanOrEqual(1);

        // Validate the refresh token claims directly
        const refreshPayload = await crypto.verify(response.refresh_token);
        expect(refreshPayload).not.toBeNull();
        const refreshExp = refreshPayload!['exp'] as number;
        const refreshIat = refreshPayload!['iat'] as number;
        expect(refreshExp - refreshIat).toBeLessThanOrEqual(86400);
        expect(refreshExp - refreshIat).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Property 35: Token Validation Completeness ──────────────────────────────

describe('Property 35: Token Validation Completeness', () => {
  /**
   * **Validates: Requirements 11.3**
   *
   * For ANY token, validation returns valid=true ONLY when ALL four conditions
   * hold simultaneously:
   * - Signature is valid (not tampered)
   * - Audience matches expected
   * - Token has not expired
   * - Token has not been revoked
   *
   * If ANY single condition fails, valid MUST be false.
   */

  // Helper to create a service and issue a valid token
  async function setupValidToken() {
    const clock = new StubClock();
    const crypto = new StubTokenCrypto();
    const tokenStore = new StubTokenStore();
    const idGenerator = new StubIdGenerator();

    const config: TokenConfig = {
      accessTokenLifetimeSeconds: 3600,
      refreshTokenLifetimeSeconds: 86400,
      signingKeyId: 'key-1',
      defaultAudience: 'may-platform',
    };

    const service = new TokenService({
      crypto,
      tokenStore,
      oidcClient: new StubOIDCClient(),
      principalResolver: new StubPrincipalResolver(),
      clock,
      idGenerator,
      config,
    });

    const response = await service.authenticate({
      tenant_id: 'tenant-1' as TenantId,
      correlation_id: 'corr-1' as CorrelationId,
      grant_type: 'password',
      username: 'user',
      password: 'pass',
      audience: 'may-platform',
    });

    return { service, clock, crypto, tokenStore, idGenerator, response };
  }

  it('valid=true only when all four conditions hold (signature, audience, expiry, revocation)', async () => {
    /**
     * We generate all 16 combinations of (signatureValid, audienceMatch, notExpired, notRevoked)
     * and verify that valid=true ONLY when all four are true.
     */
    const conditionCombinations = fc.record({
      signatureValid: fc.boolean(),
      audienceMatch: fc.boolean(),
      notExpired: fc.boolean(),
      notRevoked: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(conditionCombinations, async ({ signatureValid, audienceMatch, notExpired, notRevoked }) => {
        const clock = new StubClock(1700000000);
        const crypto = new StubTokenCrypto();
        const tokenStore = new StubTokenStore();
        const idGenerator = new StubIdGenerator();

        const config: TokenConfig = {
          accessTokenLifetimeSeconds: 3600,
          refreshTokenLifetimeSeconds: 86400,
          signingKeyId: 'key-1',
          defaultAudience: 'may-platform',
        };

        const service = new TokenService({
          crypto,
          tokenStore,
          oidcClient: new StubOIDCClient(),
          principalResolver: new StubPrincipalResolver(),
          clock,
          idGenerator,
          config,
        });

        // Issue a valid token
        const response = await service.authenticate({
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-1' as CorrelationId,
          grant_type: 'password',
          username: 'user',
          password: 'pass',
          audience: 'may-platform',
        });

        const accessToken = response.access_token;

        // Get the JTI from the token payload for revocation testing
        const payload = await crypto.verify(accessToken);
        const jti = payload!['jti'] as string;

        // Set up conditions:
        // 1. Signature: if invalid, make crypto.verify return null
        if (!signatureValid) {
          crypto.setVerifyFail(true);
        }

        // 2. Audience: use matching or non-matching audience
        const expectedAudience = audienceMatch ? 'may-platform' : 'wrong-audience';

        // 3. Expiry: if expired, advance clock past token lifetime
        if (!notExpired) {
          clock.advance(3601);
        }

        // 4. Revocation: if revoked, mark the token as revoked
        if (!notRevoked) {
          await tokenStore.revokeToken(jti);
        }

        // Validate
        const result = await service.validateToken({
          token: accessToken,
          expected_audience: expectedAudience,
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-2' as CorrelationId,
        });

        const allConditionsHold = signatureValid && audienceMatch && notExpired && notRevoked;

        if (allConditionsHold) {
          expect(result.valid).toBe(true);
        } else {
          expect(result.valid).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('invalid signature alone causes validation failure', async () => {
    await fc.assert(
      fc.asyncProperty(audienceArb, async (audience) => {
        const clock = new StubClock();
        const crypto = new StubTokenCrypto();
        const tokenStore = new StubTokenStore();
        const idGenerator = new StubIdGenerator();

        const config: TokenConfig = {
          accessTokenLifetimeSeconds: 3600,
          refreshTokenLifetimeSeconds: 86400,
          signingKeyId: 'key-1',
          defaultAudience: 'may-platform',
        };

        const service = new TokenService({
          crypto,
          tokenStore,
          oidcClient: new StubOIDCClient(),
          principalResolver: new StubPrincipalResolver(),
          clock,
          idGenerator,
          config,
        });

        // A token with an invalid signature (unknown to crypto)
        const result = await service.validateToken({
          token: 'unknown-tampered-token',
          expected_audience: audience,
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-1' as CorrelationId,
        });

        expect(result.valid).toBe(false);
        expect(result.reason).toBe('INVALID_SIGNATURE');
      }),
      { numRuns: 50 },
    );
  });

  it('audience mismatch alone causes validation failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s !== 'may-platform'),
        async (wrongAudience) => {
          const { service, response } = await setupValidToken();

          const result = await service.validateToken({
            token: response.access_token,
            expected_audience: wrongAudience,
            tenant_id: 'tenant-1' as TenantId,
            correlation_id: 'corr-1' as CorrelationId,
          });

          expect(result.valid).toBe(false);
          expect(result.reason).toBe('AUDIENCE_MISMATCH');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('expired token alone causes validation failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3601, max: 100000 }),
        async (secondsPastExpiry) => {
          const clock = new StubClock();
          const crypto = new StubTokenCrypto();
          const tokenStore = new StubTokenStore();
          const idGenerator = new StubIdGenerator();

          const config: TokenConfig = {
            accessTokenLifetimeSeconds: 3600,
            refreshTokenLifetimeSeconds: 86400,
            signingKeyId: 'key-1',
            defaultAudience: 'may-platform',
          };

          const service = new TokenService({
            crypto,
            tokenStore,
            oidcClient: new StubOIDCClient(),
            principalResolver: new StubPrincipalResolver(),
            clock,
            idGenerator,
            config,
          });

          const response = await service.authenticate({
            tenant_id: 'tenant-1' as TenantId,
            correlation_id: 'corr-1' as CorrelationId,
            grant_type: 'password',
            username: 'user',
            password: 'pass',
            audience: 'may-platform',
          });

          // Advance clock past expiry
          clock.advance(secondsPastExpiry);

          const result = await service.validateToken({
            token: response.access_token,
            expected_audience: 'may-platform',
            tenant_id: 'tenant-1' as TenantId,
            correlation_id: 'corr-2' as CorrelationId,
          });

          expect(result.valid).toBe(false);
          expect(result.reason).toBe('EXPIRED');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('revoked token alone causes validation failure', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const clock = new StubClock();
        const crypto = new StubTokenCrypto();
        const tokenStore = new StubTokenStore();
        const idGenerator = new StubIdGenerator();

        const config: TokenConfig = {
          accessTokenLifetimeSeconds: 3600,
          refreshTokenLifetimeSeconds: 86400,
          signingKeyId: 'key-1',
          defaultAudience: 'may-platform',
        };

        const service = new TokenService({
          crypto,
          tokenStore,
          oidcClient: new StubOIDCClient(),
          principalResolver: new StubPrincipalResolver(),
          clock,
          idGenerator,
          config,
        });

        const response = await service.authenticate({
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-1' as CorrelationId,
          grant_type: 'password',
          username: 'user',
          password: 'pass',
          audience: 'may-platform',
        });

        // Get the JTI and revoke it
        const payload = await crypto.verify(response.access_token);
        const jti = payload!['jti'] as string;
        await tokenStore.revokeToken(jti);

        const result = await service.validateToken({
          token: response.access_token,
          expected_audience: 'may-platform',
          tenant_id: 'tenant-1' as TenantId,
          correlation_id: 'corr-2' as CorrelationId,
        });

        expect(result.valid).toBe(false);
        expect(result.reason).toBe('REVOKED');
      }),
      { numRuns: 20 },
    );
  });

  it('token with all conditions valid passes validation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3599 }),
        async (secondsElapsed) => {
          const clock = new StubClock();
          const crypto = new StubTokenCrypto();
          const tokenStore = new StubTokenStore();
          const idGenerator = new StubIdGenerator();

          const config: TokenConfig = {
            accessTokenLifetimeSeconds: 3600,
            refreshTokenLifetimeSeconds: 86400,
            signingKeyId: 'key-1',
            defaultAudience: 'may-platform',
          };

          const service = new TokenService({
            crypto,
            tokenStore,
            oidcClient: new StubOIDCClient(),
            principalResolver: new StubPrincipalResolver(),
            clock,
            idGenerator,
            config,
          });

          const response = await service.authenticate({
            tenant_id: 'tenant-1' as TenantId,
            correlation_id: 'corr-1' as CorrelationId,
            grant_type: 'password',
            username: 'user',
            password: 'pass',
            audience: 'may-platform',
          });

          // Advance clock but stay within token lifetime
          clock.advance(secondsElapsed);

          const result = await service.validateToken({
            token: response.access_token,
            expected_audience: 'may-platform',
            tenant_id: 'tenant-1' as TenantId,
            correlation_id: 'corr-2' as CorrelationId,
          });

          expect(result.valid).toBe(true);
          expect(result.claims).toBeDefined();
          expect(result.claims!.aud).toBe('may-platform');
        },
      ),
      { numRuns: 100 },
    );
  });
});
