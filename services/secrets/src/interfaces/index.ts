/**
 * Secrets service interfaces.
 * Service contracts and dependency injection interfaces.
 *
 * @see Requirement 19 - Secrets Management and Cryptographic Key Lifecycle
 */

import type { RequestContext } from '@may/types';
import type {
  KeyMetadata,
  SecretRequest,
  SecretResponse,
  RotationRequest,
  RotationResponse,
  RevocationRequest,
  RevocationResponse,
  EncryptRequest,
  EncryptResponse,
  DecryptRequest,
  DecryptResponse,
  KeyType,
  CryptoAlgorithm,
  KeyPurpose,
  KeyLifecycleAuditPayload,
  RotationPolicy,
} from '../types/index.js';

// ─── ISecretsService ─────────────────────────────────────────────────────────

/**
 * Primary service interface for the Secrets_Service.
 * Provides secret retrieval, key rotation, revocation, and cryptographic operations.
 *
 * All operations are tenant-scoped and require a valid RequestContext.
 */
export interface ISecretsService {
  /**
   * Retrieves a secret/key reference from the KMS.
   * Returns metadata and an opaque KMS reference — never raw key material.
   *
   * @param request - The secret retrieval request
   * @param ctx - The authenticated request context
   * @returns The secret response with metadata and KMS reference
   * @throws PlatformError with category NOT_FOUND if key doesn't exist
   * @throws PlatformError with category AUTHORIZATION if tenant mismatch
   */
  getSecret(request: SecretRequest, ctx: RequestContext): Promise<SecretResponse>;

  /**
   * Rotates a cryptographic key, creating a new version.
   * Enforces rotation policy: symmetric ≤90 days, asymmetric ≤365 days.
   * Retains only the 2 most recent key versions.
   *
   * @param request - The rotation request
   * @param ctx - The authenticated request context
   * @returns The rotation response with new and previous version metadata
   * @throws PlatformError with category NOT_FOUND if key doesn't exist
   * @throws PlatformError with category POLICY_VIOLATION if rotation not yet due (unless forced)
   */
  rotateKey(request: RotationRequest, ctx: RequestContext): Promise<RotationResponse>;

  /**
   * Revokes a secret, marking it as revoked and propagating to all consumers.
   * Propagation must complete within 5 minutes per Requirement 19.5.
   *
   * @param request - The revocation request
   * @param ctx - The authenticated request context
   * @returns The revocation response with propagation details
   * @throws PlatformError with category NOT_FOUND if key doesn't exist
   */
  revokeSecret(request: RevocationRequest, ctx: RequestContext): Promise<RevocationResponse>;

  /**
   * Encrypts data using a specified key via the KMS provider.
   *
   * @param request - The encryption request with plaintext and key reference
   * @param ctx - The authenticated request context
   * @returns The encryption response with ciphertext and metadata
   * @throws PlatformError with category NOT_FOUND if key doesn't exist
   * @throws PlatformError with category VALIDATION if key is revoked/expired
   */
  encrypt(request: EncryptRequest, ctx: RequestContext): Promise<EncryptResponse>;

  /**
   * Decrypts data using a specified key and version via the KMS provider.
   *
   * @param request - The decryption request with ciphertext and key reference
   * @param ctx - The authenticated request context
   * @returns The decryption response with plaintext
   * @throws PlatformError with category NOT_FOUND if key doesn't exist
   * @throws PlatformError with category VALIDATION if key version is revoked
   */
  decrypt(request: DecryptRequest, ctx: RequestContext): Promise<DecryptResponse>;
}

// ─── IKMSProvider ────────────────────────────────────────────────────────────

/** Parameters for creating a new key in the KMS. */
export interface CreateKeyParams {
  /** Type of key to create. */
  readonly key_type: KeyType;

  /** Algorithm for the key. */
  readonly algorithm: CryptoAlgorithm;

  /** Purpose of the key. */
  readonly purpose: KeyPurpose;

  /** Tenant that owns the key. */
  readonly tenant_id: string;

  /** Optional key policy/tags for the KMS. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** Result of a KMS encryption operation. */
export interface KMSEncryptResult {
  /** Ciphertext (base64 encoded). */
  readonly ciphertext: string;

  /** Initialization vector / nonce (base64 encoded). */
  readonly iv: string;

  /** Authentication tag (base64 encoded, for AEAD ciphers). */
  readonly auth_tag?: string;
}

/** Result of a KMS decryption operation. */
export interface KMSDecryptResult {
  /** Decrypted plaintext (base64 encoded). */
  readonly plaintext: string;
}

/**
 * Abstraction over external KMS/Vault (FIPS 140-2 Level 2+).
 * All cryptographic operations are delegated to this provider.
 *
 * Implementations may wrap AWS KMS, Azure Key Vault, HashiCorp Vault, etc.
 */
export interface IKMSProvider {
  /**
   * Creates a new key in the external KMS.
   *
   * @param params - Key creation parameters
   * @returns The KMS key reference identifier
   */
  createKey(params: CreateKeyParams): Promise<string>;

  /**
   * Rotates a key in the KMS, creating a new version.
   *
   * @param kmsKeyRef - The existing KMS key reference
   * @returns The new KMS key reference for the rotated version
   */
  rotateKey(kmsKeyRef: string): Promise<string>;

  /**
   * Disables/revokes a key in the KMS.
   *
   * @param kmsKeyRef - The KMS key reference to revoke
   */
  revokeKey(kmsKeyRef: string): Promise<void>;

  /**
   * Destroys a key version in the KMS (for version cleanup).
   *
   * @param kmsKeyRef - The KMS key reference to destroy
   */
  destroyKeyVersion(kmsKeyRef: string): Promise<void>;

  /**
   * Encrypts plaintext using the specified KMS key.
   *
   * @param kmsKeyRef - The KMS key reference
   * @param plaintext - Base64-encoded plaintext
   * @param aad - Optional additional authenticated data
   * @returns Encryption result with ciphertext, IV, and optional auth tag
   */
  encrypt(kmsKeyRef: string, plaintext: string, aad?: string): Promise<KMSEncryptResult>;

  /**
   * Decrypts ciphertext using the specified KMS key.
   *
   * @param kmsKeyRef - The KMS key reference
   * @param ciphertext - Base64-encoded ciphertext
   * @param iv - Base64-encoded initialization vector
   * @param authTag - Optional base64-encoded authentication tag
   * @param aad - Optional additional authenticated data
   * @returns Decryption result with plaintext
   */
  decrypt(
    kmsKeyRef: string,
    ciphertext: string,
    iv: string,
    authTag?: string,
    aad?: string,
  ): Promise<KMSDecryptResult>;

  /**
   * Checks if the KMS provider is healthy and reachable.
   *
   * @returns True if the provider is healthy
   */
  healthCheck(): Promise<boolean>;
}

// ─── IKeyStore ───────────────────────────────────────────────────────────────

/**
 * Interface for key metadata storage.
 * Stores metadata about keys managed by the Secrets_Service.
 * The actual key material lives in the external KMS.
 */
export interface IKeyStore {
  /**
   * Stores key metadata.
   *
   * @param metadata - The key metadata to store
   */
  save(metadata: KeyMetadata): Promise<void>;

  /**
   * Retrieves key metadata by key ID and optional version.
   * If version is not specified, returns the latest active version.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @param version - Optional specific version
   * @returns The key metadata, or null if not found
   */
  get(keyId: string, tenantId: string, version?: number): Promise<KeyMetadata | null>;

  /**
   * Retrieves all versions of a key for a tenant.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @returns All versions of the key, ordered by version descending
   */
  getAllVersions(keyId: string, tenantId: string): Promise<KeyMetadata[]>;

  /**
   * Updates the status of a key.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @param version - The version to update
   * @param status - The new status
   */
  updateStatus(
    keyId: string,
    tenantId: string,
    version: number,
    status: KeyMetadata['status'],
  ): Promise<void>;

  /**
   * Deletes key metadata for a specific version.
   *
   * @param keyId - The key identifier
   * @param tenantId - The tenant identifier
   * @param version - The version to delete
   */
  delete(keyId: string, tenantId: string, version: number): Promise<void>;

  /**
   * Lists all keys for a tenant that need rotation based on policy.
   *
   * @param tenantId - The tenant identifier
   * @param policy - The rotation policy to check against
   * @param now - Current timestamp for age calculation
   * @returns Keys that are due for rotation
   */
  getKeysNeedingRotation(
    tenantId: string,
    policy: RotationPolicy,
    now: Date,
  ): Promise<KeyMetadata[]>;
}

// ─── IClock ──────────────────────────────────────────────────────────────────

/**
 * Clock abstraction for testability.
 * Allows tests to control time without mocking global Date.
 */
export interface IClock {
  /** Returns the current time as a Date object. */
  now(): Date;

  /** Returns the current time as an ISO 8601 string. */
  nowISO(): string;
}

// ─── IAuditEmitter ───────────────────────────────────────────────────────────

/**
 * Interface for emitting audit events for key lifecycle operations.
 * Decouples the Secrets_Service from the Audit_Service implementation.
 */
export interface IAuditEmitter {
  /**
   * Emits a key lifecycle audit event.
   *
   * @param payload - The audit event payload
   * @param ctx - The request context for correlation
   */
  emit(payload: KeyLifecycleAuditPayload, ctx: RequestContext): Promise<void>;
}

// ─── IRevocationPropagator ───────────────────────────────────────────────────

/**
 * Interface for propagating key revocations to all consumers.
 * Must complete propagation within 5 minutes per Requirement 19.5.
 */
export interface IRevocationPropagator {
  /**
   * Propagates a key revocation to all registered consumers.
   *
   * @param keyId - The revoked key identifier
   * @param tenantId - The tenant that owns the key
   * @param reason - Reason for revocation
   * @returns Number of consumers notified
   */
  propagate(keyId: string, tenantId: string, reason: string): Promise<number>;
}
