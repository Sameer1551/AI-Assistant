/**
 * @may/secrets - Secrets Service
 *
 * Provides runtime secret retrieval, key rotation, revocation, and
 * cryptographic operations backed by an external KMS/Vault (FIPS 140-2 Level 2+).
 *
 * @see Requirement 19 - Secrets Management and Cryptographic Key Lifecycle
 */

// Types
export type {
  KeyType,
  KeyStatus,
  CryptoAlgorithm,
  KeyPurpose,
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
  RotationPolicy,
  KeyLifecycleEventType,
  KeyLifecycleAuditPayload,
} from './types/index.js';

export { DEFAULT_ROTATION_POLICY } from './types/index.js';

// Interfaces
export type {
  ISecretsService,
  IKMSProvider,
  IKeyStore,
  IClock,
  IAuditEmitter,
  IRevocationPropagator,
  CreateKeyParams,
  KMSEncryptResult,
  KMSDecryptResult,
} from './interfaces/index.js';

// Implementation
export { SecretsService } from './secrets-service.js';
export type { SecretsServiceDependencies } from './secrets-service.js';

// Rotation Scheduler
export { RotationScheduler } from './rotation-scheduler.js';
export type {
  RotationSchedulerDependencies,
  RotationCheckResult,
  RotationScanResult,
} from './rotation-scheduler.js';

// Revocation Propagator
export { RevocationPropagatorImpl } from './revocation-propagator.js';
export type {
  RevocationConsumer,
  NotificationRecord,
} from './revocation-propagator.js';

// In-Memory Implementations (Testing Only)
export { InMemoryKMSProvider } from './in-memory-kms-provider.js';
export { InMemoryKeyVersionStore } from './in-memory-key-version-store.js';
