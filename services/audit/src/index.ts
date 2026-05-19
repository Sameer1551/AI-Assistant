/**
 * @may/audit - Audit Service
 *
 * Tamper-evident audit logging with cryptographic chaining and SIEM forwarding.
 *
 * @see Requirement 21 - Tamper-Evident Audit Logging
 */

// Interfaces
export type {
  IAuditService,
  IAuditEventStore,
  IChainHasher,
  IChainSigner,
  IngestRequest,
  AuditAck,
  AuditQuery,
  AuditQueryResponse,
  VerifyRequest,
  VerifyResult,
  ChainViolation,
  ChainViolationType,
  ChainHashInput,
  RetentionEnforcementResult,
  ISIEMForwarder,
  SIEMEndpointConfig,
  ForwardResult,
  IDurableBuffer,
  BufferedEntry,
} from './interfaces/index.js';

// Implementations
export { AuditIngestionService } from './audit-ingestion-service.js';
export { SHA256ChainHasher } from './sha256-chain-hasher.js';
export { HMACChainSigner } from './chain-signer.js';
export type { ISigningKeyProvider } from './chain-signer.js';
export { InMemoryAuditEventStore } from './in-memory-audit-event-store.js';
export { InMemoryDurableBuffer } from './in-memory-durable-buffer.js';
export { SIEMForwardingService, DEFAULT_SIEM_FORWARDING_CONFIG } from './siem-forwarding-service.js';
export type {
  SIEMForwardingConfig,
  AlertSeverity,
  SIEMAlert,
  IAlertEmitter,
  ISIEMConfigProvider,
} from './siem-forwarding-service.js';

// Types
export type { AuditServiceConfig } from './types/index.js';
export { DEFAULT_AUDIT_CONFIG } from './types/index.js';
