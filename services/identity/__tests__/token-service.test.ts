/**
 * Unit tests for TokenService — authentication, refresh, and validation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenService } from '../src/token-service.js';
import type {
  ITokenCrypto,
  ITokenStore,
  IOIDCClient,
  IPrincipalResolver,
  IClock,
  IIdGenerator,
  TokenConfig,
  RefreshTokenRecord,
  AuthRequest,
  RefreshRequest,
  TokenValidationRequest,
  OIDCValidationResult,
  ResolvedPrincipal,
} from '../src/interfaces/index.js';
import type { TenantId, PrincipalId, SessionId, CorrelationId, ISOTimestamp } from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTenantId(id: string): TenantId {
  return id as TenantId;
}

function makePrincipalId(id: string): PrincipalId {
  return id as PrincipalId;
}

function makeCorrelationId(id: string): CorrelationId {
  return id as CorrelationId;
}

function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

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

  set(seconds: number): void {
    this.currentSeconds = seconds;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  uuid(): string {
    this.counter++;
    return `uuid-${this.counter}`;
  }
}

class MockTokenCrypto implements ITokenCrypto {
  private readonly tokens: Map<string, Record<string, unknown>> = new Map();
  private tokenCounter = 0;

  async sign(payload: Record<string, unknown>, _keyId: string): Promise<string> {
    this.tokenCounter++;
    const token = `mock-jwt-${this.tokenCounter}`;
    this.tokens.set(token, { ...payload });
    return token;
  }

  async verify(token: string): Promise<Record<string, unknown> | null> {
    return this.tokens.get(token) ?? null;
  }

  /** Inject a token for testing verification */
  injectToken(token: string, payload: Record<string, unknown>): void {
    this.tokens.set(token, payload);
  }
}

class MockTokenStore implements ITokenStore {
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
    // Not needed for these tests
  }
}

class MockOIDCClient implements IOIDCClient {
  private result: OIDCValidationResult | null = null;

  setResult(result: OIDCValidationResult | null): void {
    this.result = result;
  }

  async validateExternalToken(_idToken: string, _tenantId: TenantId): Promise<OIDCValidationResult | null> {
    return this.result;
  }
}

class MockPrincipalResolver implements IPrincipalResolver {
  private readonly principals: Map<string, ResolvedPrincipal> = new Map();
  private readonly credentials: Map<string, ResolvedPrincipal> = new Map();
  private readonly clientCreds: Map<string, ResolvedPrincipal> = new Map();

  registerPrincipal(externalSub: string, principal: ResolvedPrincipal): void {
    this.principals.set(externalSub, principal);
  }

  registerCredentials(username: string, password: string, principal: ResolvedPrincipal): void {
    this.credentials.set(`${username}:${password}`, principal);
  }

  registerClientCredentials(clientId: string, clientSecret: string, principal: ResolvedPrincipal): void {
    this.clientCreds.set(`${clientId}:${clientSecret}`, principal);
  }

  async resolve(externalSub: string, _tenantId: TenantId): Promise<ResolvedPrincipal | null> {
    return this.principals.get(externalSub) ?? null;
  }

  async resolveCredentials(username: string, password: string, _tenantId: TenantId): Promise<ResolvedPrincipal | null> {
    return this.credentials.get(`${username}:${password}`) ?? null;
  }

  async resolveClientCredentials(clientId: string, clientSecret: string, _tenantId: TenantId): Promise<ResolvedPrincipal | null> {
    return this.clientCreds.get(`${clientId}:${clientSecret}`) ?? null;
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('TokenService', () => {
  let service: TokenService;
  let clock: MockClock;
  let idGenerator: MockIdGenerator;
  let crypto: MockTokenCrypto;
  let tokenStore: MockTokenStore;
  let oidcClient: MockOIDCClient;
  let principalResolver: MockPrincipalResolver;

  const defaultConfig: TokenConfig = {
    accessTokenLifetimeSeconds: 3600,
    refreshTokenLifetimeSeconds: 86400,
    signingKeyId: 'key-1',
    defaultAudience: 'may-platform',
  };

  beforeEach(() => {
    clock = new MockClock();
    idGenerator = new MockIdGenerator();
    crypto = new MockTokenCrypto();
    tokenStore = new MockTokenStore();
    oidcClient = new MockOIDCClient();
    principalResolver = new MockPrincipalResolver();

    service = new TokenService({
      crypto,
      tokenStore,
      oidcClient,
      principalResolver,
      clock,
      idGenerator,
      config: defaultConfig,
    });
  });

  describe('authenticate', () => {
    it('should issue tokens for valid password credentials', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      };

      const response = await service.authenticate(request);

      expect(response.token_type).toBe('Bearer');
      expect(response.access_token).toBeDefined();
      expect(response.refresh_token).toBeDefined();
      expect(response.expires_in).toBe(3600);
      expect(response.refresh_expires_in).toBe(86400);
      expect(response.session_id).toBeDefined();
    });

    it('should throw AUTHENTICATION error for invalid password', async () => {
      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'wrong',
        audience: 'may-platform',
      };

      await expect(service.authenticate(request)).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        category: 'AUTHENTICATION',
      });
    });

    it('should throw AUTHENTICATION error when username/password missing', async () => {
      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        audience: 'may-platform',
      };

      await expect(service.authenticate(request)).rejects.toMatchObject({
        code: 'MISSING_CREDENTIALS',
        category: 'AUTHENTICATION',
      });
    });

    it('should issue tokens for valid OIDC token exchange', async () => {
      oidcClient.setResult({
        external_sub: 'ext-user-123',
        email: 'alice@example.com',
        issuer: 'https://idp.example.com',
        audience: 'client-id',
      });

      principalResolver.registerPrincipal('ext-user-123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'oidc_token',
        id_token: 'external-id-token',
        audience: 'may-platform',
      };

      const response = await service.authenticate(request);

      expect(response.token_type).toBe('Bearer');
      expect(response.access_token).toBeDefined();
      expect(response.refresh_token).toBeDefined();
    });

    it('should throw when OIDC token validation fails', async () => {
      oidcClient.setResult(null);

      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'oidc_token',
        id_token: 'invalid-token',
        audience: 'may-platform',
      };

      await expect(service.authenticate(request)).rejects.toMatchObject({
        code: 'INVALID_OIDC_TOKEN',
        category: 'AUTHENTICATION',
      });
    });

    it('should throw when no platform principal mapped to external identity', async () => {
      oidcClient.setResult({
        external_sub: 'unknown-ext-user',
        issuer: 'https://idp.example.com',
        audience: 'client-id',
      });

      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'oidc_token',
        id_token: 'valid-token',
        audience: 'may-platform',
      };

      await expect(service.authenticate(request)).rejects.toMatchObject({
        code: 'PRINCIPAL_NOT_FOUND',
        category: 'AUTHENTICATION',
      });
    });

    it('should issue tokens for valid client credentials', async () => {
      principalResolver.registerClientCredentials('svc-client', 'svc-secret', {
        principal_id: makePrincipalId('principal-svc'),
        roles: ['service'],
      });

      const request: AuthRequest = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'client_credentials',
        client_id: 'svc-client',
        client_secret: 'svc-secret',
        audience: 'may-platform',
      };

      const response = await service.authenticate(request);

      expect(response.token_type).toBe('Bearer');
      expect(response.access_token).toBeDefined();
    });

    it('should throw for unsupported grant type', async () => {
      const request = {
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'unknown' as 'password',
        audience: 'may-platform',
      };

      await expect(service.authenticate(request)).rejects.toMatchObject({
        code: 'UNSUPPORTED_GRANT_TYPE',
        category: 'AUTHENTICATION',
      });
    });
  });

  describe('refreshToken', () => {
    it('should issue new tokens for a valid refresh token', async () => {
      // First authenticate to get a refresh token
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      const refreshRequest: RefreshRequest = {
        refresh_token: authResponse.refresh_token,
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-2'),
        audience: 'may-platform',
      };

      const response = await service.refreshToken(refreshRequest);

      expect(response.token_type).toBe('Bearer');
      expect(response.access_token).toBeDefined();
      expect(response.refresh_token).toBeDefined();
      // New tokens should be different from old ones
      expect(response.access_token).not.toBe(authResponse.access_token);
      expect(response.refresh_token).not.toBe(authResponse.refresh_token);
    });

    it('should revoke old refresh token after rotation', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      // Refresh once
      await service.refreshToken({
        refresh_token: authResponse.refresh_token,
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-2'),
        audience: 'may-platform',
      });

      // Try to use the old refresh token again — should fail
      await expect(
        service.refreshToken({
          refresh_token: authResponse.refresh_token,
          tenant_id: makeTenantId('tenant-1'),
          correlation_id: makeCorrelationId('corr-3'),
          audience: 'may-platform',
        }),
      ).rejects.toMatchObject({
        code: 'REVOKED_REFRESH_TOKEN',
        category: 'AUTHENTICATION',
      });
    });

    it('should reject refresh token with invalid signature', async () => {
      const request: RefreshRequest = {
        refresh_token: 'invalid-token',
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        audience: 'may-platform',
      };

      await expect(service.refreshToken(request)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
        category: 'AUTHENTICATION',
      });
    });

    it('should reject expired refresh token', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      // Advance time past refresh token expiry (24h + 1s)
      clock.advance(86401);

      await expect(
        service.refreshToken({
          refresh_token: authResponse.refresh_token,
          tenant_id: makeTenantId('tenant-1'),
          correlation_id: makeCorrelationId('corr-2'),
          audience: 'may-platform',
        }),
      ).rejects.toMatchObject({
        code: 'EXPIRED_REFRESH_TOKEN',
        category: 'AUTHENTICATION',
      });
    });

    it('should reject refresh token from different tenant', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      await expect(
        service.refreshToken({
          refresh_token: authResponse.refresh_token,
          tenant_id: makeTenantId('tenant-2'),
          correlation_id: makeCorrelationId('corr-2'),
          audience: 'may-platform',
        }),
      ).rejects.toMatchObject({
        code: 'TENANT_MISMATCH',
        category: 'AUTHENTICATION',
      });
    });
  });

  describe('validateToken', () => {
    it('should validate a valid token', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      const validationRequest: TokenValidationRequest = {
        token: authResponse.access_token,
        expected_audience: 'may-platform',
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-2'),
      };

      const result = await service.validateToken(validationRequest);

      expect(result.valid).toBe(true);
      expect(result.claims).toBeDefined();
      expect(result.claims!.sub).toBe('principal-alice');
      expect(result.claims!.tenant_id).toBe('tenant-1');
      expect(result.claims!.roles).toEqual(['End_User']);
    });

    it('should reject token with invalid signature', async () => {
      const result = await service.validateToken({
        token: 'invalid-token',
        expected_audience: 'may-platform',
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_SIGNATURE');
    });

    it('should reject token with wrong audience', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      const result = await service.validateToken({
        token: authResponse.access_token,
        expected_audience: 'wrong-audience',
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-2'),
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('AUDIENCE_MISMATCH');
    });

    it('should reject expired token', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      // Advance time past access token expiry (60min + 1s)
      clock.advance(3601);

      const result = await service.validateToken({
        token: authResponse.access_token,
        expected_audience: 'may-platform',
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-2'),
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('EXPIRED');
    });

    it('should reject revoked token', async () => {
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      const authResponse = await service.authenticate({
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-1'),
        grant_type: 'password',
        username: 'alice',
        password: 'secret123',
        audience: 'may-platform',
      });

      // Revoke the access token's JTI
      // The mock ID generator produces: uuid-1 (session), uuid-2 (access jti), uuid-3 (refresh jti)
      await tokenStore.revokeToken('uuid-2');

      const result = await service.validateToken({
        token: authResponse.access_token,
        expected_audience: 'may-platform',
        tenant_id: makeTenantId('tenant-1'),
        correlation_id: makeCorrelationId('corr-2'),
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('REVOKED');
    });
  });

  describe('token lifetime enforcement', () => {
    it('should clamp access token lifetime to max 60 minutes', () => {
      const svc = new TokenService({
        crypto,
        tokenStore,
        oidcClient,
        principalResolver,
        clock,
        idGenerator,
        config: {
          ...defaultConfig,
          accessTokenLifetimeSeconds: 7200, // 2 hours — should be clamped
        },
      });

      // Verify by authenticating and checking expires_in
      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      return svc
        .authenticate({
          tenant_id: makeTenantId('tenant-1'),
          correlation_id: makeCorrelationId('corr-1'),
          grant_type: 'password',
          username: 'alice',
          password: 'secret123',
          audience: 'may-platform',
        })
        .then((response) => {
          expect(response.expires_in).toBe(3600);
        });
    });

    it('should clamp refresh token lifetime to max 24 hours', () => {
      const svc = new TokenService({
        crypto,
        tokenStore,
        oidcClient,
        principalResolver,
        clock,
        idGenerator,
        config: {
          ...defaultConfig,
          refreshTokenLifetimeSeconds: 172800, // 48 hours — should be clamped
        },
      });

      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      return svc
        .authenticate({
          tenant_id: makeTenantId('tenant-1'),
          correlation_id: makeCorrelationId('corr-1'),
          grant_type: 'password',
          username: 'alice',
          password: 'secret123',
          audience: 'may-platform',
        })
        .then((response) => {
          expect(response.refresh_expires_in).toBe(86400);
        });
    });

    it('should enforce minimum lifetime of 1 second', () => {
      const svc = new TokenService({
        crypto,
        tokenStore,
        oidcClient,
        principalResolver,
        clock,
        idGenerator,
        config: {
          ...defaultConfig,
          accessTokenLifetimeSeconds: -100,
          refreshTokenLifetimeSeconds: 0,
        },
      });

      principalResolver.registerCredentials('alice', 'secret123', {
        principal_id: makePrincipalId('principal-alice'),
        roles: ['End_User'],
      });

      return svc
        .authenticate({
          tenant_id: makeTenantId('tenant-1'),
          correlation_id: makeCorrelationId('corr-1'),
          grant_type: 'password',
          username: 'alice',
          password: 'secret123',
          audience: 'may-platform',
        })
        .then((response) => {
          expect(response.expires_in).toBe(1);
          expect(response.refresh_expires_in).toBe(1);
        });
    });
  });
});
