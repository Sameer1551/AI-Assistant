/**
 * @module oidc-federation-provider
 * OIDC federation with external identity providers.
 *
 * Implements the IOIDCClient interface with:
 * - OIDC discovery via /.well-known/openid-configuration
 * - External ID token validation (signature, issuer, audience, expiry)
 * - JWKS fetching and caching for signature verification
 * - Multi-tenant provider configuration
 *
 * Uses the jose library for JWT verification against external IdP JWKS.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyResult } from 'jose';
import type { TenantId } from '@may/types';
import type { IOIDCClient, OIDCValidationResult } from './interfaces/index.js';

/**
 * OIDC provider configuration for a tenant.
 */
export interface OIDCProviderConfig {
  /** The OIDC issuer URL (e.g., https://accounts.google.com). */
  readonly issuer: string;
  /** The client ID registered with the external IdP. */
  readonly clientId: string;
  /** The OIDC discovery endpoint URL. Defaults to {issuer}/.well-known/openid-configuration. */
  readonly discoveryUrl?: string;
  /** The JWKS URI for the external IdP. If not provided, fetched from discovery. */
  readonly jwksUri?: string;
  /** Additional allowed audiences beyond the client ID. */
  readonly additionalAudiences?: readonly string[];
}

/**
 * OIDC discovery document (subset of fields we use).
 */
interface OIDCDiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly userinfo_endpoint?: string;
}

/**
 * Interface for fetching HTTP resources (injectable for testing).
 */
export interface IHttpFetcher {
  /**
   * Fetch a JSON resource from a URL.
   *
   * @param url - The URL to fetch
   * @returns Parsed JSON response
   * @throws Error on network failure or non-2xx response
   */
  fetchJson<T>(url: string): Promise<T>;
}

/**
 * Default HTTP fetcher using the global fetch API.
 */
export class DefaultHttpFetcher implements IHttpFetcher {
  async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
    }
    return response.json() as Promise<T>;
  }
}

/**
 * Tenant OIDC provider registry — maps tenant IDs to their OIDC configurations.
 */
export interface IOIDCProviderRegistry {
  /**
   * Get the OIDC provider configuration for a tenant.
   *
   * @param tenantId - The tenant to look up
   * @returns Provider config, or null if no OIDC provider is configured
   */
  getProviderConfig(tenantId: TenantId): Promise<OIDCProviderConfig | null>;
}

/**
 * In-memory OIDC provider registry for development/testing.
 *
 * @remarks
 * SWAPPABLE: Replace with a database-backed registry for production.
 */
export class InMemoryOIDCProviderRegistry implements IOIDCProviderRegistry {
  private readonly providers: Map<string, OIDCProviderConfig> = new Map();

  /**
   * Register an OIDC provider for a tenant.
   */
  registerProvider(tenantId: TenantId, config: OIDCProviderConfig): void {
    this.providers.set(tenantId as string, config);
  }

  async getProviderConfig(tenantId: TenantId): Promise<OIDCProviderConfig | null> {
    return this.providers.get(tenantId as string) ?? null;
  }
}

/**
 * OIDC Federation Provider — validates external IdP tokens for platform authentication.
 *
 * Supports OIDC discovery, JWKS-based signature verification, and multi-tenant
 * provider configuration. Caches JWKS sets per issuer for performance.
 *
 * @example
 * ```typescript
 * const provider = new OIDCFederationProvider({
 *   providerRegistry: registry,
 *   httpFetcher: new DefaultHttpFetcher(),
 *   discoveryCache: new Map(),
 * });
 *
 * const result = await provider.validateExternalToken(idToken, tenantId);
 * ```
 */
export class OIDCFederationProvider implements IOIDCClient {
  private readonly providerRegistry: IOIDCProviderRegistry;
  private readonly httpFetcher: IHttpFetcher;
  private readonly discoveryCache: Map<string, OIDCDiscoveryDocument>;
  private readonly jwksCache: Map<string, ReturnType<typeof createRemoteJWKSet>>;

  constructor(deps: {
    readonly providerRegistry: IOIDCProviderRegistry;
    readonly httpFetcher: IHttpFetcher;
    readonly discoveryCache?: Map<string, OIDCDiscoveryDocument>;
  }) {
    this.providerRegistry = deps.providerRegistry;
    this.httpFetcher = deps.httpFetcher;
    this.discoveryCache = deps.discoveryCache ?? new Map();
    this.jwksCache = new Map();
  }

  /**
   * Validate an external OIDC ID token and extract claims.
   *
   * Performs the following checks:
   * 1. Looks up the tenant's OIDC provider configuration
   * 2. Fetches OIDC discovery document (cached)
   * 3. Verifies the token signature against the IdP's JWKS
   * 4. Validates issuer, audience, and expiry
   * 5. Extracts subject, email, and name claims
   *
   * @param idToken - The external ID token to validate
   * @param tenantId - Tenant context for provider configuration lookup
   * @returns Validated external claims, or null if validation fails
   */
  async validateExternalToken(idToken: string, tenantId: TenantId): Promise<OIDCValidationResult | null> {
    try {
      // 1. Get provider config for this tenant
      const providerConfig = await this.providerRegistry.getProviderConfig(tenantId);
      if (!providerConfig) {
        return null;
      }

      // 2. Get or fetch discovery document
      const discovery = await this.getDiscoveryDocument(providerConfig);
      if (!discovery) {
        return null;
      }

      // 3. Get JWKS for signature verification
      const jwks = this.getJWKS(discovery.jwks_uri);

      // 4. Verify the token
      const allowedAudiences = [
        providerConfig.clientId,
        ...(providerConfig.additionalAudiences ?? []),
      ];

      const result: JWTVerifyResult = await jwtVerify(idToken, jwks, {
        issuer: providerConfig.issuer,
        audience: allowedAudiences,
      });

      // 5. Extract claims
      const payload = result.payload;
      const sub = payload.sub;
      if (!sub) {
        return null;
      }

      return {
        external_sub: sub,
        email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
        name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
        issuer: providerConfig.issuer,
        audience: providerConfig.clientId,
      };
    } catch {
      // Any validation failure returns null
      return null;
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch and cache the OIDC discovery document for a provider.
   */
  private async getDiscoveryDocument(config: OIDCProviderConfig): Promise<OIDCDiscoveryDocument | null> {
    const cacheKey = config.issuer;
    const cached = this.discoveryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // If jwksUri is provided directly, skip discovery
    if (config.jwksUri) {
      const doc: OIDCDiscoveryDocument = {
        issuer: config.issuer,
        jwks_uri: config.jwksUri,
      };
      this.discoveryCache.set(cacheKey, doc);
      return doc;
    }

    // Fetch from discovery endpoint
    const discoveryUrl = config.discoveryUrl ?? `${config.issuer}/.well-known/openid-configuration`;

    try {
      const doc = await this.httpFetcher.fetchJson<OIDCDiscoveryDocument>(discoveryUrl);

      // Validate the discovery document
      if (!doc.issuer || !doc.jwks_uri) {
        return null;
      }

      this.discoveryCache.set(cacheKey, doc);
      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Get or create a remote JWKS set for a given URI.
   */
  private getJWKS(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    const cached = this.jwksCache.get(jwksUri);
    if (cached) {
      return cached;
    }

    const jwks = createRemoteJWKSet(new URL(jwksUri));
    this.jwksCache.set(jwksUri, jwks);
    return jwks;
  }
}
