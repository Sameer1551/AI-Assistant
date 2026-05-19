/**
 * SecretsService implementation.
 *
 * Provides runtime secret retrieval, key rotation, revocation, and
 * cryptographic operations backed by an external KMS/Vault.
 *
 * @see Requirement 19 - Secrets Management and Cryptographic Key Lifecycle
 */

import type { PlatformError, RequestContext, ISOTimestamp, TenantId } from '@may/types';
import type {
  ISecretsService,
  IKMSProvider,
  IKeyStore,
  IClock,
  IAuditEmitter,
  IRevocationPropagator,
} from './interfaces/index.js';
import type {
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
  RotationPolicy,
  KeyMetadata,
} from './types/index.js';
import { DEFAULT_ROTATION_POLICY } from './types/index.js';

// ─── Helper: Create PlatformError ────────────────────────────────────────────

function createError(
  params: Pick<PlatformError, 'code' | 'category' | 'severity' | 'message' | 'retryable'> & {
    correlation_id: string;
    tenant_id?: string;
    details?: Record<string, unknown>;
    retry_after_ms?: number;
  },
): PlatformError {
  return {
    code: params.code,
    category: params.category,
    severity: params.severity,
    message: params.message,
    correlation_id: params.correlation_id as PlatformError['correlation_id'],
    tenant_id: params.tenant_id as PlatformError['tenant_id'],
    source_service: 'Secrets_Service',
    retryable: params.retryable,
    retry_after_ms: params.retry_after_ms,
    details: params.details,
    timestamp: new Date().toISOString(),
  };
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/** Dependencies injected into the SecretsService. */
export interface SecretsServiceDependencies {
  /** External KMS/Vault provider (FIPS 140-2 Level 2+). */
  readonly kmsProvider: IKMSProvider;

  /** Key metadata storage. */
  readonly keyStore: IKeyStore;

  /** Clock abstraction for testability. */
  readonly clock: IClock;

  /** Audit event emitter for key lifecycle events. */
  readonly auditEmitter: IAuditEmitter;

  /** Revocation propagator for notifying consumers. */
  readonly revocationPropagator: IRevocationPropagator;

  /** Rotation policy configuration. */
  readonly rotationPolicy?: RotationPolicy;
}

// ─── SecretsService Implementation ──────────────────────────────────────────

/**
 * Production implementation of the Secrets_Service.
 *
 * All cryptographic key material is stored exclusively in the external KMS/Vault.
 * This service manages metadata, enforces rotation policy, handles revocation
 * propagation, and delegates encrypt/decrypt operations to the KMS provider.
 *
 * @see Requirement 19.1 - Keys stored exclusively in external KMS (FIPS 140-2 Level 2+)
 * @see Requirement 19.2 - Secrets retrieved only at runtime through authenticated calls
 * @see Requirement 19.3 - Symmetric ≤90 days, asymmetric ≤365 days rotation
 * @see Requirement 19.4 - Retain only 2 most recent key versions
 * @see Requirement 19.5 - Revocation propagates within 5 minutes
 * @see Requirement 19.6 - Encrypt all data at rest using managed keys
 */
export class SecretsService implements ISecretsService {
  private readonly kmsProvider: IKMSProvider;
  private readonly keyStore: IKeyStore;
  private readonly clock: IClock;
  private readonly auditEmitter: IAuditEmitter;
  private readonly revocationPropagator: IRevocationPropagator;
  private readonly rotationPolicy: RotationPolicy;

  constructor(deps: SecretsServiceDependencies) {
    this.kmsProvider = deps.kmsProvider;
    this.keyStore = deps.keyStore;
    this.clock = deps.clock;
    this.auditEmitter = deps.auditEmitter;
    this.revocationPropagator = deps.revocationPropagator;
    this.rotationPolicy = deps.rotationPolicy ?? DEFAULT_ROTATION_POLICY;
  }

  /**
   * Retrieves a secret/key reference from the KMS.
   * Returns metadata and an opaque KMS reference — never raw key material.
   */
  async getSecret(request: SecretRequest, ctx: RequestContext): Promise<SecretResponse> {
    this.validateTenantAccess(request.tenant_id, ctx);

    const metadata = await this.keyStore.get(
      request.key_id,
      request.tenant_id,
      request.version,
    );

    if (!metadata) {
      throw createError({
        code: 'KEY_NOT_FOUND',
        category: 'NOT_FOUND',
        severity: 'LOW',
        message: `Key '${request.key_id}' not found for tenant`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
      });
    }

    if (metadata.status === 'revoked') {
      throw createError({
        code: 'KEY_REVOKED',
        category: 'VALIDATION',
        severity: 'MEDIUM',
        message: `Key '${request.key_id}' has been revoked`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
        details: { key_id: request.key_id, status: metadata.status },
      });
    }

    // Determine if this is the current (latest active) version
    const allVersions = await this.keyStore.getAllVersions(request.key_id, request.tenant_id);
    const latestActive = allVersions.find((v) => v.status === 'active');
    const isCurrent = latestActive?.version === metadata.version;

    await this.auditEmitter.emit(
      {
        event_type: 'key.accessed',
        key_id: request.key_id,
        key_version: metadata.version,
        tenant_id: request.tenant_id,
      },
      ctx,
    );

    return {
      metadata,
      kms_key_ref: metadata.kms_key_ref,
      is_current: isCurrent,
    };
  }

  /**
   * Rotates a cryptographic key, creating a new version.
   * Enforces rotation policy and retains only 2 most recent versions.
   */
  async rotateKey(request: RotationRequest, ctx: RequestContext): Promise<RotationResponse> {
    this.validateTenantAccess(request.tenant_id, ctx);

    const allVersions = await this.keyStore.getAllVersions(request.key_id, request.tenant_id);
    const currentVersion = allVersions.find((v) => v.status === 'active');

    if (!currentVersion) {
      throw createError({
        code: 'KEY_NOT_FOUND',
        category: 'NOT_FOUND',
        severity: 'LOW',
        message: `Active key '${request.key_id}' not found for tenant`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
      });
    }

    // Check if rotation is due (unless forced)
    if (!request.force) {
      const needsRotation = this.isRotationDue(currentVersion);
      if (!needsRotation) {
        throw createError({
          code: 'ROTATION_NOT_DUE',
          category: 'POLICY_VIOLATION',
          severity: 'LOW',
          message: `Key '${request.key_id}' does not yet require rotation per policy`,
          correlation_id: request.correlation_id,
          tenant_id: request.tenant_id,
          retryable: false,
          details: {
            key_type: currentVersion.key_type,
            rotated_at: currentVersion.rotated_at,
            max_age_days: currentVersion.key_type === 'symmetric'
              ? this.rotationPolicy.symmetric_max_age_days
              : this.rotationPolicy.asymmetric_max_age_days,
          },
        });
      }
    }

    // Create new key version in KMS
    const newKmsRef = await this.kmsProvider.rotateKey(currentVersion.kms_key_ref);

    const now = this.clock.nowISO() as ISOTimestamp;
    const newVersion: KeyMetadata = {
      key_id: request.key_id,
      key_type: currentVersion.key_type,
      algorithm: currentVersion.algorithm,
      purpose: currentVersion.purpose,
      created_at: now,
      rotated_at: now,
      expires_at: this.computeExpiryDate(currentVersion.key_type) as ISOTimestamp,
      version: currentVersion.version + 1,
      status: 'active',
      tenant_id: request.tenant_id as TenantId,
      kms_key_ref: newKmsRef,
    };

    // Save new version
    await this.keyStore.save(newVersion);

    // Clean up old versions — retain only 2 most recent
    const expiredCount = await this.cleanupOldVersions(
      request.key_id,
      request.tenant_id,
      allVersions,
      newVersion.version,
    );

    // Emit audit event
    await this.auditEmitter.emit(
      {
        event_type: 'key.rotated',
        key_id: request.key_id,
        key_version: newVersion.version,
        tenant_id: request.tenant_id,
        details: {
          previous_version: currentVersion.version,
          expired_versions_cleaned: expiredCount,
        },
      },
      ctx,
    );

    return {
      new_version: newVersion,
      previous_version: currentVersion,
      expired_versions_cleaned: expiredCount,
    };
  }

  /**
   * Revokes a secret, marking it as revoked and propagating to all consumers.
   * Propagation must complete within 5 minutes.
   */
  async revokeSecret(
    request: RevocationRequest,
    ctx: RequestContext,
  ): Promise<RevocationResponse> {
    this.validateTenantAccess(request.tenant_id, ctx);

    const allVersions = await this.keyStore.getAllVersions(request.key_id, request.tenant_id);
    if (allVersions.length === 0) {
      throw createError({
        code: 'KEY_NOT_FOUND',
        category: 'NOT_FOUND',
        severity: 'LOW',
        message: `Key '${request.key_id}' not found for tenant`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
      });
    }

    const now = this.clock.now();
    const revokedAt = this.clock.nowISO() as ISOTimestamp;

    // Revoke all active versions of this key
    for (const version of allVersions) {
      if (version.status === 'active') {
        await this.keyStore.updateStatus(
          request.key_id,
          request.tenant_id,
          version.version,
          'revoked',
        );
        await this.kmsProvider.revokeKey(version.kms_key_ref);
      }
    }

    // Propagate revocation to all consumers (must complete within 5 minutes)
    const consumersNotified = await this.revocationPropagator.propagate(
      request.key_id,
      request.tenant_id,
      request.reason,
    );

    // Calculate propagation deadline (5 minutes from now)
    const propagationDeadline = new Date(now.getTime() + 5 * 60 * 1000);

    // Emit audit event
    await this.auditEmitter.emit(
      {
        event_type: 'key.revoked',
        key_id: request.key_id,
        tenant_id: request.tenant_id,
        details: {
          reason: request.reason,
          emergency: request.emergency,
          consumers_notified: consumersNotified,
          versions_revoked: allVersions.filter((v) => v.status === 'active').length,
        },
      },
      ctx,
    );

    // Return the most recent version as the "revoked key" reference
    const revokedKey: KeyMetadata = {
      ...allVersions[0]!,
      status: 'revoked',
    };

    return {
      revoked_key: revokedKey,
      revoked_at: revokedAt,
      propagation_deadline: propagationDeadline.toISOString() as ISOTimestamp,
      consumers_notified: consumersNotified,
    };
  }

  /**
   * Encrypts data using a specified key via the KMS provider.
   */
  async encrypt(request: EncryptRequest, ctx: RequestContext): Promise<EncryptResponse> {
    this.validateTenantAccess(request.tenant_id, ctx);

    const metadata = await this.keyStore.get(request.key_id, request.tenant_id);

    if (!metadata) {
      throw createError({
        code: 'KEY_NOT_FOUND',
        category: 'NOT_FOUND',
        severity: 'LOW',
        message: `Key '${request.key_id}' not found for tenant`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
      });
    }

    this.validateKeyUsable(metadata, request.correlation_id, request.tenant_id);

    // Delegate encryption to KMS provider
    const result = await this.kmsProvider.encrypt(
      metadata.kms_key_ref,
      request.plaintext,
      request.aad,
    );

    // Emit audit event
    await this.auditEmitter.emit(
      {
        event_type: 'key.encrypt',
        key_id: request.key_id,
        key_version: metadata.version,
        tenant_id: request.tenant_id,
      },
      ctx,
    );

    return {
      ciphertext: result.ciphertext,
      key_version: metadata.version,
      key_id: request.key_id,
      algorithm: metadata.algorithm,
      iv: result.iv,
      auth_tag: result.auth_tag,
    };
  }

  /**
   * Decrypts data using a specified key and version via the KMS provider.
   */
  async decrypt(request: DecryptRequest, ctx: RequestContext): Promise<DecryptResponse> {
    this.validateTenantAccess(request.tenant_id, ctx);

    const metadata = await this.keyStore.get(
      request.key_id,
      request.tenant_id,
      request.key_version,
    );

    if (!metadata) {
      throw createError({
        code: 'KEY_NOT_FOUND',
        category: 'NOT_FOUND',
        severity: 'LOW',
        message: `Key '${request.key_id}' version ${request.key_version} not found`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
      });
    }

    // Revoked keys cannot be used for decryption
    if (metadata.status === 'revoked') {
      throw createError({
        code: 'KEY_REVOKED',
        category: 'VALIDATION',
        severity: 'MEDIUM',
        message: `Key '${request.key_id}' version ${request.key_version} has been revoked`,
        correlation_id: request.correlation_id,
        tenant_id: request.tenant_id,
        retryable: false,
        details: { key_id: request.key_id, version: request.key_version },
      });
    }

    // Delegate decryption to KMS provider
    const result = await this.kmsProvider.decrypt(
      metadata.kms_key_ref,
      request.ciphertext,
      request.iv,
      request.auth_tag,
      request.aad,
    );

    // Emit audit event
    await this.auditEmitter.emit(
      {
        event_type: 'key.decrypt',
        key_id: request.key_id,
        key_version: metadata.version,
        tenant_id: request.tenant_id,
      },
      ctx,
    );

    return {
      plaintext: result.plaintext,
      key_version: metadata.version,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Validates that the request tenant matches the authenticated context tenant.
   */
  private validateTenantAccess(requestTenantId: string, ctx: RequestContext): void {
    if (requestTenantId !== ctx.tenant_id) {
      throw createError({
        code: 'TENANT_MISMATCH',
        category: 'AUTHORIZATION',
        severity: 'HIGH',
        message: 'Request tenant does not match authenticated tenant',
        correlation_id: ctx.correlation_id,
        tenant_id: ctx.tenant_id,
        retryable: false,
      });
    }
  }

  /**
   * Validates that a key is usable (not revoked or expired).
   */
  private validateKeyUsable(
    metadata: KeyMetadata,
    correlationId: string,
    tenantId: string,
  ): void {
    if (metadata.status === 'revoked') {
      throw createError({
        code: 'KEY_REVOKED',
        category: 'VALIDATION',
        severity: 'MEDIUM',
        message: `Key '${metadata.key_id}' has been revoked`,
        correlation_id: correlationId,
        tenant_id: tenantId,
        retryable: false,
        details: { key_id: metadata.key_id, status: metadata.status },
      });
    }

    if (metadata.status === 'expired') {
      throw createError({
        code: 'KEY_EXPIRED',
        category: 'VALIDATION',
        severity: 'MEDIUM',
        message: `Key '${metadata.key_id}' has expired`,
        correlation_id: correlationId,
        tenant_id: tenantId,
        retryable: false,
        details: { key_id: metadata.key_id, expires_at: metadata.expires_at },
      });
    }
  }

  /**
   * Determines if a key is due for rotation based on the rotation policy.
   * Symmetric keys: ≤90 days, Asymmetric keys: ≤365 days.
   */
  private isRotationDue(metadata: KeyMetadata): boolean {
    const now = this.clock.now();
    const rotatedAt = new Date(metadata.rotated_at);
    const ageMs = now.getTime() - rotatedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    const maxAgeDays = metadata.key_type === 'symmetric'
      ? this.rotationPolicy.symmetric_max_age_days
      : this.rotationPolicy.asymmetric_max_age_days;

    return ageDays >= maxAgeDays;
  }

  /**
   * Computes the expiry date for a new key version based on its type.
   */
  private computeExpiryDate(keyType: KeyMetadata['key_type']): string {
    const now = this.clock.now();
    const maxAgeDays = keyType === 'symmetric'
      ? this.rotationPolicy.symmetric_max_age_days
      : this.rotationPolicy.asymmetric_max_age_days;

    const expiryDate = new Date(now.getTime() + maxAgeDays * 24 * 60 * 60 * 1000);
    return expiryDate.toISOString();
  }

  /**
   * Cleans up old key versions, retaining only the 2 most recent.
   * Marks older versions as expired and destroys them in the KMS.
   *
   * @returns Number of versions cleaned up
   */
  private async cleanupOldVersions(
    keyId: string,
    tenantId: string,
    existingVersions: KeyMetadata[],
    newVersionNumber: number,
  ): Promise<number> {
    // All versions including the new one, sorted descending by version
    const allVersionNumbers = [
      newVersionNumber,
      ...existingVersions.map((v) => v.version),
    ].sort((a, b) => b - a);

    // Keep only the top N versions
    const versionsToRemove = allVersionNumbers.slice(this.rotationPolicy.max_versions_retained);
    let cleanedCount = 0;

    for (const versionNum of versionsToRemove) {
      const versionMeta = existingVersions.find((v) => v.version === versionNum);
      if (versionMeta && versionMeta.status !== 'expired') {
        // Mark as expired in metadata store
        await this.keyStore.updateStatus(keyId, tenantId, versionNum, 'expired');

        // Destroy in KMS
        await this.kmsProvider.destroyKeyVersion(versionMeta.kms_key_ref);

        cleanedCount++;
      }
    }

    return cleanedCount;
  }
}
