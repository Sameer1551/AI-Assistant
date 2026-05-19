/**
 * @may/identity - Identity Service
 *
 * Provides authentication, token issuance, RBAC/ABAC evaluation,
 * Confirmation_Challenge issuance/validation, service-to-service
 * authentication (mTLS/SPIFFE), and break-glass emergency access
 * for the May platform.
 */

// Interfaces (dependency injection contracts)
export type {
  ITokenService,
  ITokenCrypto,
  ITokenStore,
  IOIDCClient,
  IPrincipalResolver,
  IClock,
  IIdGenerator,
  TokenClaims,
  AuthRequest,
  TokenResponse,
  RefreshRequest,
  TokenValidationRequest,
  ValidationResult,
  TokenConfig,
  RefreshTokenRecord,
  OIDCValidationResult,
  ResolvedPrincipal,
  // Authorization interfaces
  IAuthorizationService,
  IPolicyStore,
  IAuthzAuditEmitter,
  AuthzRequest,
  AuthzDecision,
  PermissionGrant,
  AttributeCondition,
  RoleDefinition,
  RoleAssignment,
  AuthzAuditPayload,
  BuiltInRole,
  // Service-to-service authentication interfaces
  ServiceCertificate,
  ServiceIdentity,
  BreakGlassRequest,
  BreakGlassGrant,
  BreakGlassApproval,
  IServiceAuthenticator,
  IBreakGlassManager,
  IAuditEmitter,
  ITrustDomainRegistry,
  ICertificateRevocationChecker,
  IServiceCallPolicy,
  // Confirmation Challenge interfaces
  IConfirmationChallengeService,
  IChallengeStore,
  ILockoutStore,
  INonceGenerator,
  IChallengeAuditEmitter,
  IssueChallengeRequest,
  ValidateChallengeRequest,
  ChallengeValidationResult,
  ChallengeRejectionReason,
  ChallengeAuditEventType,
  ChallengeAuditPayload,
  ConfirmationChallengeConfig,
} from './interfaces/index.js';

export { BUILT_IN_ROLES } from './interfaces/index.js';

// Token Service implementation
export { TokenService } from './token-service.js';
export type { TokenServiceDependencies } from './token-service.js';

// Token Validator (standalone validation pipeline)
export { TokenValidator } from './token-validator.js';
export type { TokenValidatorDependencies, ValidationFailureReason } from './token-validator.js';

// Jose-based JWT crypto implementation
export { JoseTokenCrypto } from './jose-token-crypto.js';
export type { JoseTokenCryptoConfig } from './jose-token-crypto.js';

// In-memory token store (swappable)
export { InMemoryTokenStore } from './in-memory-token-store.js';

// OIDC Federation Provider
export { OIDCFederationProvider, InMemoryOIDCProviderRegistry, DefaultHttpFetcher } from './oidc-federation-provider.js';
export type { OIDCProviderConfig, IOIDCProviderRegistry, IHttpFetcher } from './oidc-federation-provider.js';

// Authorization Service implementation
export { AuthorizationService } from './authorization-service.js';
export type { AuthorizationServiceDependencies } from './authorization-service.js';

// In-memory policy store (swappable — for testing)
export { InMemoryPolicyStore, BUILT_IN_ROLE_PERMISSIONS, createBuiltInRoles } from './in-memory-policy-store.js';

// Service-to-service authentication (mTLS/SPIFFE)
export { ServiceAuthenticator, parseSpiffeId } from './service-authenticator.js';
export type { ServiceAuthenticatorDependencies } from './service-authenticator.js';

// Break-glass emergency access manager
export { BreakGlassManager, MAX_BREAK_GLASS_DURATION_SECONDS, REQUIRED_APPROVER_COUNT } from './break-glass-manager.js';
export type { BreakGlassManagerDependencies, IBreakGlassGrantStore } from './break-glass-manager.js';

// Confirmation Challenge Service
export { ConfirmationChallengeService, MAX_CHALLENGE_EXPIRY_SECONDS, DEFAULT_MAX_FAILURES_BEFORE_LOCKOUT, DEFAULT_LOCKOUT_DURATION_SECONDS } from './confirmation-challenge-service.js';
export type { ConfirmationChallengeServiceDependencies } from './confirmation-challenge-service.js';

// In-memory challenge and lockout stores (swappable)
export { InMemoryChallengeStore, InMemoryLockoutStore } from './in-memory-challenge-store.js';

// Crypto nonce generator
export { CryptoNonceGenerator } from './crypto-nonce-generator.js';

// Internal constants
export { MAX_ACCESS_TOKEN_LIFETIME_SECONDS, MAX_REFRESH_TOKEN_LIFETIME_SECONDS } from './types/index.js';
