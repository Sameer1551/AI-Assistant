/**
 * @module token-service
 * Token issuance, refresh, and validation implementation.
 *
 * Implements the ITokenService interface with:
 * - Access token lifetime ≤60 minutes (3600 seconds)
 * - Refresh token lifetime ≤24 hours (86400 seconds)
 * - Full validation: signature, audience, expiry, revocation status
 * - OIDC federation with external identity providers
 *
 * All external dependencies are injected for testability.
 */

import type {
  PlatformError,
  PrincipalId,
  CorrelationId,
  SessionId,
  TenantId,
} from '@may/types';

import type {
  ITokenService,
  ITokenCrypto,
  ITokenStore,
  IOIDCClient,
  IPrincipalResolver,
  IClock,
  IIdGenerator,
  AuthRequest,
  TokenResponse,
  RefreshRequest,
  TokenValidationRequest,
  ValidationResult,
  TokenClaims,
  TokenConfig,
  RefreshTokenRecord,
} from './interfaces/index.js';

/** Maximum allowed access token lifetime: 60 minutes. */
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;

/** Maximum allowed refresh token lifetime: 24 hours. */
const MAX_REFRESH_TOKEN_LIFETIME_SECONDS = 86400;

/**
 * Dependencies required by the TokenService.
 */
export interface TokenServiceDependencies {
  readonly crypto: ITokenCrypto;
  readonly tokenStore: ITokenStore;
  readonly oidcClient: IOIDCClient;
  readonly principalResolver: IPrincipalResolver;
  readonly clock: IClock;
  readonly idGenerator: IIdGenerator;
  readonly config: TokenConfig;
}

/**
 * Production implementation of the ITokenService interface.
 *
 * Handles authentication (password, OIDC federation, client credentials),
 * token refresh, and comprehensive token validation.
 */
export class TokenService implements ITokenService {
  private readonly crypto: ITokenCrypto;
  private readonly tokenStore: ITokenStore;
  private readonly oidcClient: IOIDCClient;
  private readonly principalResolver: IPrincipalResolver;
  private readonly clock: IClock;
  private readonly idGenerator: IIdGenerator;
  private readonly config: TokenConfig;

  constructor(deps: TokenServiceDependencies) {
    this.crypto = deps.crypto;
    this.tokenStore = deps.tokenStore;
    this.oidcClient = deps.oidcClient;
    this.principalResolver = deps.principalResolver;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
    this.config = this.validateConfig(deps.config);
  }

  /**
   * Authenticate a principal and issue access + refresh tokens.
   *
   * Supports three grant types:
   * - 'password': validates username/password against the principal resolver
   * - 'oidc_token': validates external IdP token and maps to platform principal
   * - 'client_credentials': validates client ID/secret for service accounts
   *
   * @param request - Authentication request
   * @returns Token response with access and refresh tokens
   * @throws PlatformError with category AUTHENTICATION on failure
   */
  async authenticate(request: AuthRequest): Promise<TokenResponse> {
    const { grant_type, tenant_id, correlation_id, audience } = request;

    switch (grant_type) {
      case 'password': {
        if (!request.username || !request.password) {
          throw this.createAuthError(
            'MISSING_CREDENTIALS',
            'Username and password are required for password grant',
            correlation_id,
            tenant_id,
          );
        }

        const principal = await this.principalResolver.resolveCredentials(
          request.username,
          request.password,
          tenant_id,
        );

        if (!principal) {
          throw this.createAuthError(
            'INVALID_CREDENTIALS',
            'Invalid username or password',
            correlation_id,
            tenant_id,
          );
        }

        return this.issueTokenPair(principal.principal_id, principal.roles, tenant_id, audience, correlation_id);
      }

      case 'oidc_token': {
        if (!request.id_token) {
          throw this.createAuthError(
            'MISSING_ID_TOKEN',
            'id_token is required for OIDC token exchange',
            correlation_id,
            tenant_id,
          );
        }

        const oidcResult = await this.oidcClient.validateExternalToken(request.id_token, tenant_id);

        if (!oidcResult) {
          throw this.createAuthError(
            'INVALID_OIDC_TOKEN',
            'External OIDC token validation failed',
            correlation_id,
            tenant_id,
          );
        }

        const principal = await this.principalResolver.resolve(oidcResult.external_sub, tenant_id);

        if (!principal) {
          throw this.createAuthError(
            'PRINCIPAL_NOT_FOUND',
            'No platform principal mapped to external identity',
            correlation_id,
            tenant_id,
          );
        }

        return this.issueTokenPair(principal.principal_id, principal.roles, tenant_id, audience, correlation_id);
      }

      case 'client_credentials': {
        if (!request.client_id || !request.client_secret) {
          throw this.createAuthError(
            'MISSING_CLIENT_CREDENTIALS',
            'client_id and client_secret are required for client_credentials grant',
            correlation_id,
            tenant_id,
          );
        }

        const principal = await this.principalResolver.resolveClientCredentials(
          request.client_id,
          request.client_secret,
          tenant_id,
        );

        if (!principal) {
          throw this.createAuthError(
            'INVALID_CLIENT_CREDENTIALS',
            'Invalid client credentials',
            correlation_id,
            tenant_id,
          );
        }

        return this.issueTokenPair(principal.principal_id, principal.roles, tenant_id, audience, correlation_id);
      }

      default: {
        throw this.createAuthError(
          'UNSUPPORTED_GRANT_TYPE',
          `Unsupported grant type: ${grant_type as string}`,
          correlation_id,
          tenant_id,
        );
      }
    }
  }

  /**
   * Exchange a valid refresh token for a new access + refresh token pair.
   *
   * Validates the refresh token's signature, expiry, and revocation status
   * before issuing new tokens. The old refresh token is revoked after use
   * (rotation).
   *
   * @param request - Refresh request
   * @returns New token response
   * @throws PlatformError with category AUTHENTICATION if refresh token is invalid
   */
  async refreshToken(request: RefreshRequest): Promise<TokenResponse> {
    const { refresh_token, tenant_id, correlation_id, audience } = request;

    // Verify the refresh token signature
    const payload = await this.crypto.verify(refresh_token);
    if (!payload) {
      throw this.createAuthError(
        'INVALID_REFRESH_TOKEN',
        'Refresh token signature verification failed',
        correlation_id,
        tenant_id,
      );
    }

    const jti = payload['jti'] as string | undefined;
    if (!jti) {
      throw this.createAuthError(
        'MALFORMED_REFRESH_TOKEN',
        'Refresh token missing jti claim',
        correlation_id,
        tenant_id,
      );
    }

    // Check revocation status
    const isRevoked = await this.tokenStore.isRevoked(jti);
    if (isRevoked) {
      throw this.createAuthError(
        'REVOKED_REFRESH_TOKEN',
        'Refresh token has been revoked',
        correlation_id,
        tenant_id,
      );
    }

    // Retrieve stored record for additional validation
    const record = await this.tokenStore.getRefreshToken(jti);
    if (!record) {
      throw this.createAuthError(
        'REFRESH_TOKEN_NOT_FOUND',
        'Refresh token record not found',
        correlation_id,
        tenant_id,
      );
    }

    // Validate tenant match
    if (record.tenant_id !== tenant_id) {
      throw this.createAuthError(
        'TENANT_MISMATCH',
        'Refresh token does not belong to the specified tenant',
        correlation_id,
        tenant_id,
      );
    }

    // Check expiry
    const now = this.clock.nowSeconds();
    if (record.exp <= now) {
      throw this.createAuthError(
        'EXPIRED_REFRESH_TOKEN',
        'Refresh token has expired',
        correlation_id,
        tenant_id,
      );
    }

    // Revoke the old refresh token (rotation)
    await this.tokenStore.revokeToken(jti);

    // Issue new token pair with the same session
    return this.issueTokenPair(
      record.sub,
      record.roles,
      tenant_id,
      audience,
      correlation_id,
      record.session_id,
    );
  }

  /**
   * Validate a token's signature, audience, expiry, and revocation status.
   *
   * Performs ALL four checks in order:
   * 1. Signature validity (cryptographic verification)
   * 2. Audience match (token audience matches expected)
   * 3. Expiry check (token has not expired)
   * 4. Revocation status (token JTI not in revocation list)
   *
   * @param request - Validation request
   * @returns Validation result with decoded claims if valid
   */
  async validateToken(request: TokenValidationRequest): Promise<ValidationResult> {
    const { token, expected_audience } = request;

    // 1. Verify signature
    const payload = await this.crypto.verify(token);
    if (!payload) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    // Parse claims from payload
    const claims = this.extractClaims(payload);
    if (!claims) {
      return { valid: false, reason: 'MALFORMED' };
    }

    // 2. Validate audience
    if (claims.aud !== expected_audience) {
      return { valid: false, reason: 'AUDIENCE_MISMATCH' };
    }

    // 3. Check expiry
    const now = this.clock.nowSeconds();
    if (claims.exp <= now) {
      return { valid: false, reason: 'EXPIRED' };
    }

    // 4. Check revocation status
    const isRevoked = await this.tokenStore.isRevoked(claims.jti);
    if (isRevoked) {
      return { valid: false, reason: 'REVOKED' };
    }

    return { valid: true, claims };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Issue a new access + refresh token pair.
   */
  private async issueTokenPair(
    principalId: PrincipalId,
    roles: readonly string[],
    tenantId: TenantId,
    audience: string,
    _correlationId: CorrelationId,
    existingSessionId?: SessionId,
  ): Promise<TokenResponse> {
    const now = this.clock.nowSeconds();
    const sessionId = existingSessionId ?? (this.idGenerator.uuid() as SessionId);
    const accessJti = this.idGenerator.uuid();
    const refreshJti = this.idGenerator.uuid();

    // Build access token claims
    const accessClaims: Record<string, unknown> = {
      sub: principalId,
      tenant_id: tenantId,
      roles: [...roles],
      session_id: sessionId,
      iat: now,
      exp: now + this.config.accessTokenLifetimeSeconds,
      aud: audience,
      jti: accessJti,
    };

    // Build refresh token claims
    const refreshClaims: Record<string, unknown> = {
      sub: principalId,
      tenant_id: tenantId,
      roles: [...roles],
      session_id: sessionId,
      iat: now,
      exp: now + this.config.refreshTokenLifetimeSeconds,
      aud: audience,
      jti: refreshJti,
      token_type: 'refresh',
    };

    // Sign both tokens
    const accessToken = await this.crypto.sign(accessClaims, this.config.signingKeyId);
    const refreshToken = await this.crypto.sign(refreshClaims, this.config.signingKeyId);

    // Store refresh token record for later validation
    const refreshRecord: RefreshTokenRecord = {
      jti: refreshJti,
      sub: principalId,
      tenant_id: tenantId,
      session_id: sessionId,
      roles,
      audience,
      iat: now,
      exp: now + this.config.refreshTokenLifetimeSeconds,
      revoked: false,
    };

    await this.tokenStore.storeRefreshToken(refreshJti, refreshRecord);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenLifetimeSeconds,
      refresh_expires_in: this.config.refreshTokenLifetimeSeconds,
      session_id: sessionId,
    };
  }

  /**
   * Extract and validate token claims from a decoded payload.
   */
  private extractClaims(payload: Record<string, unknown>): TokenClaims | null {
    const sub = payload['sub'];
    const tenant_id = payload['tenant_id'];
    const roles = payload['roles'];
    const session_id = payload['session_id'];
    const iat = payload['iat'];
    const exp = payload['exp'];
    const aud = payload['aud'];
    const jti = payload['jti'];

    // Validate all required fields are present and correctly typed
    if (
      typeof sub !== 'string' ||
      typeof tenant_id !== 'string' ||
      !Array.isArray(roles) ||
      typeof session_id !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      typeof aud !== 'string' ||
      typeof jti !== 'string'
    ) {
      return null;
    }

    return {
      sub: sub as TokenClaims['sub'],
      tenant_id: tenant_id as TokenClaims['tenant_id'],
      roles: roles as readonly string[],
      session_id: session_id as TokenClaims['session_id'],
      iat,
      exp,
      aud,
      jti,
    };
  }

  /**
   * Validate and clamp token configuration to enforce maximum lifetimes.
   */
  private validateConfig(config: TokenConfig): TokenConfig {
    const accessLifetime = Math.min(
      Math.max(1, config.accessTokenLifetimeSeconds),
      MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
    );
    const refreshLifetime = Math.min(
      Math.max(1, config.refreshTokenLifetimeSeconds),
      MAX_REFRESH_TOKEN_LIFETIME_SECONDS,
    );

    return {
      ...config,
      accessTokenLifetimeSeconds: accessLifetime,
      refreshTokenLifetimeSeconds: refreshLifetime,
    };
  }

  /**
   * Create a structured PlatformError for authentication failures.
   */
  private createAuthError(
    code: string,
    message: string,
    correlationId: CorrelationId,
    tenantId: TenantId,
  ): PlatformError {
    return {
      code,
      category: 'AUTHENTICATION',
      severity: 'MEDIUM',
      message,
      correlation_id: correlationId,
      tenant_id: tenantId,
      source_service: 'identity',
      retryable: false,
      timestamp: this.clock.nowISO(),
    };
  }
}
