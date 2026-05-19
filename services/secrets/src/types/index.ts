/**
 * Secrets service-specific types.
 * Types that are internal to this service.
 *
 * @see Requirement 19 - Secrets Management and Cryptographic Key Lifecycle
 */

import type { TenantId, CorrelationId, ISOTimestamp } from '@may/types';

// ─── Key Types ───────────────────────────────────────────────────────────────

/** Type of cryptographic key. */
export type KeyType = 'symmetric' | 'asymmetric';

/** Status of a key in its lifecycle. */
export type KeyStatus = 'active' | 'revoked' | 'expired';

/** Supported cryptographic algorithms. */
export type CryptoAlgorithm =
  | 'AES-256-GCM'
  | 'AES-256-CBC'
  | 'RSA-OAEP-256'
  | 'RSA-PSS-256'
  | 'ECDSA-P256'
  | 'ECDSA-P384';

/** Purpose of a key. */
export type KeyPurpose = 'encryption' | 'signing' | 'wrapping';

// ─── Key Metadata ────────────────────────────────────────────────────────────

/**
 * Metadata for a cryptographic key managed by the Secrets_Service.
 * Keys are stored in external KMS/Vault; this is the metadata record.
 */
export interface KeyMetadata {
  /** Unique identifier for the key. */
  readonly key_id: string;

  /** Type of key (symmetric or asymmetric). */
  readonly key_type: KeyType;

  /** Cryptographic algorithm used by this key. */
  readonly algorithm: CryptoAlgorithm;

  /** Purpose of the key. */
  readonly purpose: KeyPurpose;

  /** ISO 8601 timestamp when the key was created. */
  readonly created_at: ISOTimestamp;

  /** ISO 8601 timestamp when the key was last rotated. */
  readonly rotated_at: ISOTimestamp;

  /** ISO 8601 timestamp when the key expires. */
  readonly expires_at: ISOTimestamp;

  /** Version number of the key (monotonically increasing). */
  readonly version: number;

  /** Current lifecycle status of the key. */
  readonly status: KeyStatus;

  /** Tenant that owns this key. */
  readonly tenant_id: TenantId;

  /** External KMS/Vault reference identifier. */
  readonly kms_key_ref: string;
}

// ─── Request/Response Types ──────────────────────────────────────────────────

/** Request to retrieve a secret. */
export interface SecretRequest {
  /** The key identifier to retrieve. */
  readonly key_id: string;

  /** Optional specific version to retrieve (defaults to latest active). */
  readonly version?: number;

  /** Tenant context. */
  readonly tenant_id: TenantId;

  /** Correlation ID for tracing. */
  readonly correlation_id: CorrelationId;
}

/** Response containing the secret reference (never raw key material in transit). */
export interface SecretResponse {
  /** The key metadata. */
  readonly metadata: KeyMetadata;

  /** Opaque reference to the key material in KMS (not the raw key). */
  readonly kms_key_ref: string;

  /** Whether this is the latest version. */
  readonly is_current: boolean;
}

/** Request to rotate a key. */
export interface RotationRequest {
  /** The key identifier to rotate. */
  readonly key_id: string;

  /** Tenant context. */
  readonly tenant_id: TenantId;

  /** Correlation ID for tracing. */
  readonly correlation_id: CorrelationId;

  /** Whether to force rotation regardless of age. */
  readonly force?: boolean;
}

/** Response after key rotation. */
export interface RotationResponse {
  /** The new key version metadata. */
  readonly new_version: KeyMetadata;

  /** The previous key version metadata (now second-most-recent). */
  readonly previous_version: KeyMetadata;

  /** Number of expired versions cleaned up. */
  readonly expired_versions_cleaned: number;
}

/** Request to revoke a secret. */
export interface RevocationRequest {
  /** The key identifier to revoke. */
  readonly key_id: string;

  /** Tenant context. */
  readonly tenant_id: TenantId;

  /** Correlation ID for tracing. */
  readonly correlation_id: CorrelationId;

  /** Reason for revocation. */
  readonly reason: string;

  /** Whether this is an emergency revocation (suspected compromise). */
  readonly emergency: boolean;
}

/** Response after secret revocation. */
export interface RevocationResponse {
  /** The revoked key metadata. */
  readonly revoked_key: KeyMetadata;

  /** ISO 8601 timestamp when revocation was initiated. */
  readonly revoked_at: ISOTimestamp;

  /** Estimated propagation completion time. */
  readonly propagation_deadline: ISOTimestamp;

  /** Number of consumers notified. */
  readonly consumers_notified: number;
}

/** Request to encrypt data. */
export interface EncryptRequest {
  /** The key identifier to use for encryption. */
  readonly key_id: string;

  /** Plaintext data to encrypt (base64 encoded). */
  readonly plaintext: string;

  /** Optional additional authenticated data (AAD). */
  readonly aad?: string;

  /** Tenant context. */
  readonly tenant_id: TenantId;

  /** Correlation ID for tracing. */
  readonly correlation_id: CorrelationId;
}

/** Response containing encrypted data. */
export interface EncryptResponse {
  /** Ciphertext (base64 encoded). */
  readonly ciphertext: string;

  /** Key version used for encryption. */
  readonly key_version: number;

  /** Key identifier used. */
  readonly key_id: string;

  /** Algorithm used for encryption. */
  readonly algorithm: CryptoAlgorithm;

  /** Initialization vector / nonce (base64 encoded). */
  readonly iv: string;

  /** Authentication tag (base64 encoded, for AEAD ciphers). */
  readonly auth_tag?: string;
}

/** Request to decrypt data. */
export interface DecryptRequest {
  /** The key identifier used for encryption. */
  readonly key_id: string;

  /** Ciphertext to decrypt (base64 encoded). */
  readonly ciphertext: string;

  /** Key version that was used for encryption. */
  readonly key_version: number;

  /** Initialization vector / nonce (base64 encoded). */
  readonly iv: string;

  /** Authentication tag (base64 encoded, for AEAD ciphers). */
  readonly auth_tag?: string;

  /** Optional additional authenticated data (AAD). */
  readonly aad?: string;

  /** Tenant context. */
  readonly tenant_id: TenantId;

  /** Correlation ID for tracing. */
  readonly correlation_id: CorrelationId;
}

/** Response containing decrypted data. */
export interface DecryptResponse {
  /** Decrypted plaintext (base64 encoded). */
  readonly plaintext: string;

  /** Key version used for decryption. */
  readonly key_version: number;
}

// ─── Rotation Policy ─────────────────────────────────────────────────────────

/**
 * Rotation policy configuration.
 * Symmetric keys ≤90 days, asymmetric ≤365 days per Requirement 19.3.
 */
export interface RotationPolicy {
  /** Maximum age in days for symmetric keys before rotation is required. */
  readonly symmetric_max_age_days: number;

  /** Maximum age in days for asymmetric keys before rotation is required. */
  readonly asymmetric_max_age_days: number;

  /** Maximum number of key versions to retain (default: 2). */
  readonly max_versions_retained: number;
}

/** Default rotation policy per Requirement 19.3 and 19.4. */
export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  symmetric_max_age_days: 90,
  asymmetric_max_age_days: 365,
  max_versions_retained: 2,
} as const;

// ─── Audit Event Types ───────────────────────────────────────────────────────

/** Types of key lifecycle audit events. */
export type KeyLifecycleEventType =
  | 'key.created'
  | 'key.rotated'
  | 'key.revoked'
  | 'key.expired'
  | 'key.accessed'
  | 'key.encrypt'
  | 'key.decrypt'
  | 'key.version_cleaned';

/** Payload for key lifecycle audit events. */
export interface KeyLifecycleAuditPayload {
  /** The event type. */
  readonly event_type: KeyLifecycleEventType;

  /** The key identifier. */
  readonly key_id: string;

  /** The key version affected. */
  readonly key_version?: number;

  /** The tenant that owns the key. */
  readonly tenant_id: TenantId;

  /** Additional context about the event. */
  readonly details?: Readonly<Record<string, unknown>>;
}
