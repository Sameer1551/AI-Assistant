/**
 * InMemoryKMSProvider - In-memory KMS provider for testing.
 *
 * ⚠️ NON-PRODUCTION: This implementation is for testing and development only.
 * It does NOT provide FIPS 140-2 Level 2+ compliance.
 * Production deployments MUST use a real KMS (AWS KMS, Azure Key Vault, HashiCorp Vault).
 *
 * Simulates external KMS operations using in-memory crypto operations.
 *
 * @see Requirement 19.1 - Keys stored exclusively in external KMS (FIPS 140-2 Level 2+)
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import type { IKMSProvider, CreateKeyParams, KMSEncryptResult, KMSDecryptResult } from './interfaces/index.js';

// ─── Internal Key Storage ────────────────────────────────────────────────────

interface StoredKey {
  /** Unique reference for this key in the "KMS". */
  readonly ref: string;

  /** Raw key material (base64 encoded). */
  readonly material: string;

  /** Key type. */
  readonly key_type: 'symmetric' | 'asymmetric';

  /** Algorithm. */
  readonly algorithm: string;

  /** Whether the key is active (not revoked/destroyed). */
  active: boolean;

  /** Tenant that owns this key. */
  readonly tenant_id: string;

  /** Creation timestamp. */
  readonly created_at: string;
}

// ─── InMemoryKMSProvider Implementation ──────────────────────────────────────

/**
 * In-memory KMS provider for testing purposes.
 *
 * ⚠️ WARNING: This is NOT suitable for production use.
 * It stores key material in process memory and uses Node.js crypto
 * for operations. Production deployments require a FIPS 140-2 Level 2+
 * certified HSM-backed KMS.
 *
 * Features:
 * - Simulates key creation, rotation, revocation, and destruction
 * - Performs real AES-256-GCM encryption/decryption for testing
 * - Tracks all operations for test assertions
 *
 * @example
 * ```typescript
 * const kms = new InMemoryKMSProvider();
 * const ref = await kms.createKey({ key_type: 'symmetric', algorithm: 'AES-256-GCM', ... });
 * const encrypted = await kms.encrypt(ref, plaintext);
 * const decrypted = await kms.decrypt(ref, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag);
 * ```
 */
export class InMemoryKMSProvider implements IKMSProvider {
  private readonly keys: Map<string, StoredKey> = new Map();
  private nextRefId = 1;

  /** Track operations for test assertions. */
  readonly operations: Array<{ op: string; ref: string; timestamp: string }> = [];

  /**
   * Creates a new key in the in-memory store.
   *
   * @param params - Key creation parameters
   * @returns The KMS key reference identifier
   */
  async createKey(params: CreateKeyParams): Promise<string> {
    const ref = `inmem-key-${this.nextRefId++}`;
    const keySize = this.getKeySize(params.algorithm);
    const material = randomBytes(keySize).toString('base64');

    const storedKey: StoredKey = {
      ref,
      material,
      key_type: params.key_type,
      algorithm: params.algorithm,
      active: true,
      tenant_id: params.tenant_id,
      created_at: new Date().toISOString(),
    };

    this.keys.set(ref, storedKey);
    this.operations.push({ op: 'createKey', ref, timestamp: storedKey.created_at });

    return ref;
  }

  /**
   * Rotates a key by creating a new version with fresh material.
   *
   * @param kmsKeyRef - The existing KMS key reference
   * @returns The new KMS key reference for the rotated version
   */
  async rotateKey(kmsKeyRef: string): Promise<string> {
    const existing = this.keys.get(kmsKeyRef);
    if (!existing) {
      throw new Error(`KMS key not found: ${kmsKeyRef}`);
    }

    if (!existing.active) {
      throw new Error(`Cannot rotate inactive key: ${kmsKeyRef}`);
    }

    const newRef = `${kmsKeyRef}-v${this.nextRefId++}`;
    const keySize = this.getKeySize(existing.algorithm);
    const material = randomBytes(keySize).toString('base64');

    const newKey: StoredKey = {
      ref: newRef,
      material,
      key_type: existing.key_type,
      algorithm: existing.algorithm,
      active: true,
      tenant_id: existing.tenant_id,
      created_at: new Date().toISOString(),
    };

    this.keys.set(newRef, newKey);
    this.operations.push({ op: 'rotateKey', ref: newRef, timestamp: newKey.created_at });

    return newRef;
  }

  /**
   * Revokes (disables) a key in the KMS.
   *
   * @param kmsKeyRef - The KMS key reference to revoke
   */
  async revokeKey(kmsKeyRef: string): Promise<void> {
    const key = this.keys.get(kmsKeyRef);
    if (!key) {
      throw new Error(`KMS key not found: ${kmsKeyRef}`);
    }

    key.active = false;
    this.operations.push({ op: 'revokeKey', ref: kmsKeyRef, timestamp: new Date().toISOString() });
  }

  /**
   * Destroys a key version (removes material permanently).
   *
   * @param kmsKeyRef - The KMS key reference to destroy
   */
  async destroyKeyVersion(kmsKeyRef: string): Promise<void> {
    const key = this.keys.get(kmsKeyRef);
    if (key) {
      key.active = false;
    }
    // In a real KMS, this would schedule key material destruction
    this.operations.push({ op: 'destroyKeyVersion', ref: kmsKeyRef, timestamp: new Date().toISOString() });
  }

  /**
   * Encrypts plaintext using AES-256-GCM.
   *
   * @param kmsKeyRef - The KMS key reference
   * @param plaintext - Base64-encoded plaintext
   * @param aad - Optional additional authenticated data
   * @returns Encryption result with ciphertext, IV, and auth tag
   */
  async encrypt(kmsKeyRef: string, plaintext: string, aad?: string): Promise<KMSEncryptResult> {
    const key = this.getActiveKey(kmsKeyRef);
    const keyMaterial = Buffer.from(key.material, 'base64');
    const iv = randomBytes(12); // 96-bit IV for GCM
    const plaintextBuffer = Buffer.from(plaintext, 'base64');

    const cipher = createCipheriv('aes-256-gcm', keyMaterial.subarray(0, 32), iv);

    if (aad) {
      cipher.setAAD(Buffer.from(aad, 'utf8'));
    }

    const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    this.operations.push({ op: 'encrypt', ref: kmsKeyRef, timestamp: new Date().toISOString() });

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      auth_tag: authTag.toString('base64'),
    };
  }

  /**
   * Decrypts ciphertext using AES-256-GCM.
   *
   * @param kmsKeyRef - The KMS key reference
   * @param ciphertext - Base64-encoded ciphertext
   * @param iv - Base64-encoded initialization vector
   * @param authTag - Optional base64-encoded authentication tag
   * @param aad - Optional additional authenticated data
   * @returns Decryption result with plaintext
   */
  async decrypt(
    kmsKeyRef: string,
    ciphertext: string,
    iv: string,
    authTag?: string,
    aad?: string,
  ): Promise<KMSDecryptResult> {
    const key = this.getActiveKey(kmsKeyRef);
    const keyMaterial = Buffer.from(key.material, 'base64');
    const ivBuffer = Buffer.from(iv, 'base64');
    const ciphertextBuffer = Buffer.from(ciphertext, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', keyMaterial.subarray(0, 32), ivBuffer);

    if (authTag) {
      decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    }

    if (aad) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }

    const decrypted = Buffer.concat([decipher.update(ciphertextBuffer), decipher.final()]);

    this.operations.push({ op: 'decrypt', ref: kmsKeyRef, timestamp: new Date().toISOString() });

    return {
      plaintext: decrypted.toString('base64'),
    };
  }

  /**
   * Checks if the in-memory KMS is healthy (always true for testing).
   *
   * @returns Always true
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  // ─── Test Helpers ────────────────────────────────────────────────────────

  /** Returns the number of keys stored. */
  get keyCount(): number {
    return this.keys.size;
  }

  /** Returns whether a key reference exists and is active. */
  isKeyActive(ref: string): boolean {
    const key = this.keys.get(ref);
    return key?.active ?? false;
  }

  /** Clears all stored keys and operations (for test reset). */
  reset(): void {
    this.keys.clear();
    this.operations.length = 0;
    this.nextRefId = 1;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private getActiveKey(ref: string): StoredKey {
    const key = this.keys.get(ref);
    if (!key) {
      throw new Error(`KMS key not found: ${ref}`);
    }
    if (!key.active) {
      throw new Error(`KMS key is not active: ${ref}`);
    }
    return key;
  }

  private getKeySize(algorithm: string): number {
    switch (algorithm) {
      case 'AES-256-GCM':
      case 'AES-256-CBC':
        return 32;
      case 'RSA-OAEP-256':
      case 'RSA-PSS-256':
        return 256; // Simplified — real RSA keys are much larger
      case 'ECDSA-P256':
        return 32;
      case 'ECDSA-P384':
        return 48;
      default:
        return 32;
    }
  }
}
