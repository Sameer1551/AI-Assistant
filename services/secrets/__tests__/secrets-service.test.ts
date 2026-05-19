/**
 * Unit tests for SecretsService.
 *
 * Tests all 5 RPCs: GetSecret, RotateKey, RevokeSecret, Encrypt, Decrypt
 * and validates key lifecycle management per Requirement 19.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext } from '@may/types';
import type { TenantId, CorrelationId, ISOTimestamp } from '@may/types';
import { SecretsService } from '../src/secrets-service.js';
import { RotationScheduler } from '../src/rotation-scheduler.js';
import { RevocationPropagatorImpl } from '../src/revocation-propagator.js';
import { InMemoryKMSProvider } from '../src/in-memory-kms-provider.js';
import { InMemoryKeyVersionStore } from '../src/in-memory-key-version-store.js';
import type {
  IKMSProvider,
  IClock,
  IAuditEmitter,
  IRevocationPropagator,
  CreateKeyParams,
  KMSEncryptResult,
  KMSDecryptResult,
} from '../src/interfaces/index.js';
import type { KeyMetadata, RotationPolicy } from '../src/types/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'tenant-001' as TenantId;
const TEST_CORRELATION_ID = 'corr-001' as CorrelationId;

function createCtx(overrides?: Partial<RequestContext>): RequestContext {
  return {
    tenant_id: TEST_TENANT_ID,
    principal_id: 'principal-001' as RequestContext['principal_id'],
    correlation_id: TEST_CORRELATION_ID,
    session_id: 'session-001' as RequestContext['session_id'],
    trace_context: { traceparent: '00-trace-01-flags' },
    roles: ['End_User'],
    attributes: {},
    residency_region: 'us-east-1',
    ...overrides,
  };
}

function createKeyMetadata(overrides?: Partial<KeyMetadata>): KeyMetadata {
  return {
    key_id: 'key-001',
    key_type: 'symmetric',
    algorithm: 'AES-256-GCM',
    purpose: 'encryption',
    created_at: '2024-01-01T00:00:00.000Z' as ISOTimestamp,
    rotated_at: '2024-01-01T00:00:00.000Z' as ISOTimestamp,
    expires_at: '2024-04-01T00:00:00.000Z' as ISOTimestamp,
    version: 1,
    status: 'active',
    tenant_id: TEST_TENANT_ID,
    kms_key_ref: 'kms-ref-001',
    ...overrides,
  };
}

// ─── Mock Implementations ────────────────────────────────────────────────────

class MockKMSProvider implements IKMSProvider {
  createKeyCalls: CreateKeyParams[] = [];
  rotateKeyCalls: string[] = [];
  revokeKeyCalls: string[] = [];
  destroyKeyCalls: string[] = [];
  encryptCalls: Array<{ ref: string; plaintext: string; aad?: string }> = [];
  decryptCalls: Array<{ ref: string; ciphertext: string; iv: string }> = [];

  async createKey(params: CreateKeyParams): Promise<string> {
    this.createKeyCalls.push(params);
    return `kms-ref-new-${this.createKeyCalls.length}`;
  }

  async rotateKey(kmsKeyRef: string): Promise<string> {
    this.rotateKeyCalls.push(kmsKeyRef);
    return `${kmsKeyRef}-rotated`;
  }

  async revokeKey(kmsKeyRef: string): Promise<void> {
    this.revokeKeyCalls.push(kmsKeyRef);
  }

  async destroyKeyVersion(kmsKeyRef: string): Promise<void> {
    this.destroyKeyCalls.push(kmsKeyRef);
  }

  async encrypt(
    kmsKeyRef: string,
    plaintext: string,
    aad?: string,
  ): Promise<KMSEncryptResult> {
    this.encryptCalls.push({ ref: kmsKeyRef, plaintext, aad });
    return {
      ciphertext: `encrypted-${plaintext}`,
      iv: 'test-iv-base64',
      auth_tag: 'test-auth-tag',
    };
  }

  async decrypt(
    kmsKeyRef: string,
    ciphertext: string,
    iv: string,
    _authTag?: string,
    _aad?: string,
  ): Promise<KMSDecryptResult> {
    this.decryptCalls.push({ ref: kmsKeyRef, ciphertext, iv });
    return { plaintext: `decrypted-${ciphertext}` };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

class MockClock implements IClock {
  private currentTime: Date;

  constructor(time: Date = new Date('2024-06-01T00:00:00.000Z')) {
    this.currentTime = time;
  }

  now(): Date {
    return this.currentTime;
  }

  nowISO(): string {
    return this.currentTime.toISOString();
  }

  setTime(time: Date): void {
    this.currentTime = time;
  }
}

class MockAuditEmitter implements IAuditEmitter {
  events: Array<{ payload: unknown; ctx: RequestContext }> = [];

  async emit(payload: unknown, ctx: RequestContext): Promise<void> {
    this.events.push({ payload, ctx });
  }
}

class MockRevocationPropagator implements IRevocationPropagator {
  calls: Array<{ keyId: string; tenantId: string; reason: string }> = [];

  async propagate(keyId: string, tenantId: string, reason: string): Promise<number> {
    this.calls.push({ keyId, tenantId, reason });
    return 5;
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('SecretsService', () => {
  let service: SecretsService;
  let kmsProvider: MockKMSProvider;
  let keyStore: InMemoryKeyVersionStore;
  let clock: MockClock;
  let auditEmitter: MockAuditEmitter;
  let revocationPropagator: MockRevocationPropagator;
  let ctx: RequestContext;

  beforeEach(() => {
    kmsProvider = new MockKMSProvider();
    keyStore = new InMemoryKeyVersionStore();
    clock = new MockClock();
    auditEmitter = new MockAuditEmitter();
    revocationPropagator = new MockRevocationPropagator();

    service = new SecretsService({
      kmsProvider,
      keyStore,
      clock,
      auditEmitter,
      revocationPropagator,
    });

    ctx = createCtx();
  });

  // ─── GetSecret ───────────────────────────────────────────────────────────

  describe('getSecret', () => {
    it('returns key metadata and KMS reference for an active key', async () => {
      const metadata = createKeyMetadata();
      keyStore.seed(metadata);

      const result = await service.getSecret(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
        ctx,
      );

      expect(result.metadata).toEqual(metadata);
      expect(result.kms_key_ref).toBe('kms-ref-001');
      expect(result.is_current).toBe(true);
    });

    it('throws NOT_FOUND for non-existent key', async () => {
      await expect(
        service.getSecret(
          { key_id: 'nonexistent', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_NOT_FOUND', category: 'NOT_FOUND' });
    });

    it('throws VALIDATION for revoked key', async () => {
      keyStore.seed(createKeyMetadata({ status: 'revoked' }));

      await expect(
        service.getSecret(
          { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_REVOKED', category: 'VALIDATION' });
    });

    it('throws AUTHORIZATION for tenant mismatch', async () => {
      keyStore.seed(createKeyMetadata());
      const wrongCtx = createCtx({ tenant_id: 'other-tenant' as TenantId });

      await expect(
        service.getSecret(
          { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
          wrongCtx,
        ),
      ).rejects.toMatchObject({ code: 'TENANT_MISMATCH', category: 'AUTHORIZATION' });
    });

    it('emits audit event on successful retrieval', async () => {
      keyStore.seed(createKeyMetadata());

      await service.getSecret(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
        ctx,
      );

      expect(auditEmitter.events).toHaveLength(1);
      expect(auditEmitter.events[0]!.payload).toMatchObject({
        event_type: 'key.accessed',
        key_id: 'key-001',
      });
    });

    it('retrieves a specific version when requested', async () => {
      keyStore.seed(createKeyMetadata({ version: 1 }));
      keyStore.seed(createKeyMetadata({ version: 2, kms_key_ref: 'kms-ref-002' }));

      const result = await service.getSecret(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID, version: 1 },
        ctx,
      );

      expect(result.metadata.version).toBe(1);
      expect(result.is_current).toBe(false);
    });
  });

  // ─── RotateKey ───────────────────────────────────────────────────────────

  describe('rotateKey', () => {
    it('creates a new key version when rotation is due', async () => {
      // Key rotated 91 days ago (symmetric max is 90)
      const oldDate = new Date('2024-03-01T00:00:00.000Z');
      keyStore.seed(createKeyMetadata({ rotated_at: oldDate.toISOString() as ISOTimestamp }));

      const result = await service.rotateKey(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
        ctx,
      );

      expect(result.new_version.version).toBe(2);
      expect(result.new_version.status).toBe('active');
      expect(result.previous_version.version).toBe(1);
      expect(kmsProvider.rotateKeyCalls).toContain('kms-ref-001');
    });

    it('throws POLICY_VIOLATION when rotation is not yet due', async () => {
      // Key rotated today — not due for rotation
      keyStore.seed(createKeyMetadata({
        rotated_at: clock.nowISO() as ISOTimestamp,
      }));

      await expect(
        service.rotateKey(
          { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'ROTATION_NOT_DUE', category: 'POLICY_VIOLATION' });
    });

    it('allows forced rotation regardless of age', async () => {
      // Key rotated today — normally not due
      keyStore.seed(createKeyMetadata({
        rotated_at: clock.nowISO() as ISOTimestamp,
      }));

      const result = await service.rotateKey(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID, force: true },
        ctx,
      );

      expect(result.new_version.version).toBe(2);
    });

    it('retains only 2 most recent key versions', async () => {
      // Seed 2 existing versions
      keyStore.seed(createKeyMetadata({ version: 1, status: 'active', rotated_at: '2024-01-01T00:00:00.000Z' as ISOTimestamp }));
      keyStore.seed(createKeyMetadata({ version: 2, status: 'active', kms_key_ref: 'kms-ref-002', rotated_at: '2024-02-01T00:00:00.000Z' as ISOTimestamp }));

      // Force rotation to create version 3
      const result = await service.rotateKey(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID, force: true },
        ctx,
      );

      expect(result.new_version.version).toBe(3);
      expect(result.expired_versions_cleaned).toBeGreaterThanOrEqual(1);
      // Version 1 should be cleaned up (only 2 most recent retained)
      expect(kmsProvider.destroyKeyCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('emits audit event on rotation', async () => {
      keyStore.seed(createKeyMetadata({ rotated_at: '2024-01-01T00:00:00.000Z' as ISOTimestamp }));

      await service.rotateKey(
        { key_id: 'key-001', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID, force: true },
        ctx,
      );

      const rotationEvent = auditEmitter.events.find(
        (e) => (e.payload as { event_type: string }).event_type === 'key.rotated',
      );
      expect(rotationEvent).toBeDefined();
    });

    it('throws NOT_FOUND for non-existent key', async () => {
      await expect(
        service.rotateKey(
          { key_id: 'nonexistent', tenant_id: TEST_TENANT_ID, correlation_id: TEST_CORRELATION_ID },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
    });
  });

  // ─── RevokeSecret ────────────────────────────────────────────────────────

  describe('revokeSecret', () => {
    it('revokes all active versions and propagates to consumers', async () => {
      keyStore.seed(createKeyMetadata({ version: 1 }));
      keyStore.seed(createKeyMetadata({ version: 2, kms_key_ref: 'kms-ref-002' }));

      const result = await service.revokeSecret(
        {
          key_id: 'key-001',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
          reason: 'suspected compromise',
          emergency: true,
        },
        ctx,
      );

      expect(result.revoked_key.status).toBe('revoked');
      expect(result.consumers_notified).toBe(5);
      expect(result.propagation_deadline).toBeDefined();
      expect(kmsProvider.revokeKeyCalls.length).toBe(2);
    });

    it('propagation deadline is within 5 minutes', async () => {
      keyStore.seed(createKeyMetadata());

      const result = await service.revokeSecret(
        {
          key_id: 'key-001',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
          reason: 'test',
          emergency: false,
        },
        ctx,
      );

      const deadline = new Date(result.propagation_deadline);
      const now = clock.now();
      const diffMs = deadline.getTime() - now.getTime();
      // Should be exactly 5 minutes (300000ms)
      expect(diffMs).toBe(5 * 60 * 1000);
    });

    it('emits audit event with revocation details', async () => {
      keyStore.seed(createKeyMetadata());

      await service.revokeSecret(
        {
          key_id: 'key-001',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
          reason: 'suspected compromise',
          emergency: true,
        },
        ctx,
      );

      const revokeEvent = auditEmitter.events.find(
        (e) => (e.payload as { event_type: string }).event_type === 'key.revoked',
      );
      expect(revokeEvent).toBeDefined();
      expect((revokeEvent!.payload as { details: { reason: string } }).details.reason).toBe('suspected compromise');
    });

    it('throws NOT_FOUND for non-existent key', async () => {
      await expect(
        service.revokeSecret(
          {
            key_id: 'nonexistent',
            tenant_id: TEST_TENANT_ID,
            correlation_id: TEST_CORRELATION_ID,
            reason: 'test',
            emergency: false,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
    });

    it('invokes revocation propagator with correct parameters', async () => {
      keyStore.seed(createKeyMetadata());

      await service.revokeSecret(
        {
          key_id: 'key-001',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
          reason: 'key leaked',
          emergency: true,
        },
        ctx,
      );

      expect(revocationPropagator.calls).toHaveLength(1);
      expect(revocationPropagator.calls[0]).toEqual({
        keyId: 'key-001',
        tenantId: TEST_TENANT_ID,
        reason: 'key leaked',
      });
    });
  });

  // ─── Encrypt ─────────────────────────────────────────────────────────────

  describe('encrypt', () => {
    it('delegates encryption to KMS provider', async () => {
      keyStore.seed(createKeyMetadata());

      const result = await service.encrypt(
        {
          key_id: 'key-001',
          plaintext: 'aGVsbG8=', // "hello" in base64
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
        },
        ctx,
      );

      expect(result.ciphertext).toBe('encrypted-aGVsbG8=');
      expect(result.key_version).toBe(1);
      expect(result.key_id).toBe('key-001');
      expect(result.algorithm).toBe('AES-256-GCM');
      expect(result.iv).toBe('test-iv-base64');
      expect(kmsProvider.encryptCalls).toHaveLength(1);
      expect(kmsProvider.encryptCalls[0]!.ref).toBe('kms-ref-001');
    });

    it('passes AAD to KMS provider', async () => {
      keyStore.seed(createKeyMetadata());

      await service.encrypt(
        {
          key_id: 'key-001',
          plaintext: 'aGVsbG8=',
          aad: 'context-data',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
        },
        ctx,
      );

      expect(kmsProvider.encryptCalls[0]!.aad).toBe('context-data');
    });

    it('throws NOT_FOUND for non-existent key', async () => {
      await expect(
        service.encrypt(
          {
            key_id: 'nonexistent',
            plaintext: 'aGVsbG8=',
            tenant_id: TEST_TENANT_ID,
            correlation_id: TEST_CORRELATION_ID,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
    });

    it('throws VALIDATION for revoked key', async () => {
      keyStore.seed(createKeyMetadata({ status: 'revoked' }));

      await expect(
        service.encrypt(
          {
            key_id: 'key-001',
            plaintext: 'aGVsbG8=',
            tenant_id: TEST_TENANT_ID,
            correlation_id: TEST_CORRELATION_ID,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_REVOKED' });
    });

    it('throws VALIDATION for expired key', async () => {
      keyStore.seed(createKeyMetadata({ status: 'expired' }));

      await expect(
        service.encrypt(
          {
            key_id: 'key-001',
            plaintext: 'aGVsbG8=',
            tenant_id: TEST_TENANT_ID,
            correlation_id: TEST_CORRELATION_ID,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_EXPIRED' });
    });

    it('emits audit event on encryption', async () => {
      keyStore.seed(createKeyMetadata());

      await service.encrypt(
        {
          key_id: 'key-001',
          plaintext: 'aGVsbG8=',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
        },
        ctx,
      );

      expect(auditEmitter.events).toHaveLength(1);
      expect(auditEmitter.events[0]!.payload).toMatchObject({
        event_type: 'key.encrypt',
        key_id: 'key-001',
      });
    });
  });

  // ─── Decrypt ─────────────────────────────────────────────────────────────

  describe('decrypt', () => {
    it('delegates decryption to KMS provider', async () => {
      keyStore.seed(createKeyMetadata());

      const result = await service.decrypt(
        {
          key_id: 'key-001',
          ciphertext: 'encrypted-data',
          key_version: 1,
          iv: 'test-iv',
          auth_tag: 'test-tag',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
        },
        ctx,
      );

      expect(result.plaintext).toBe('decrypted-encrypted-data');
      expect(result.key_version).toBe(1);
      expect(kmsProvider.decryptCalls).toHaveLength(1);
    });

    it('throws NOT_FOUND for non-existent key version', async () => {
      keyStore.seed(createKeyMetadata({ version: 1 }));

      await expect(
        service.decrypt(
          {
            key_id: 'key-001',
            ciphertext: 'data',
            key_version: 99,
            iv: 'iv',
            tenant_id: TEST_TENANT_ID,
            correlation_id: TEST_CORRELATION_ID,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
    });

    it('throws VALIDATION for revoked key version', async () => {
      keyStore.seed(createKeyMetadata({ status: 'revoked' }));

      await expect(
        service.decrypt(
          {
            key_id: 'key-001',
            ciphertext: 'data',
            key_version: 1,
            iv: 'iv',
            tenant_id: TEST_TENANT_ID,
            correlation_id: TEST_CORRELATION_ID,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'KEY_REVOKED' });
    });

    it('emits audit event on decryption', async () => {
      keyStore.seed(createKeyMetadata());

      await service.decrypt(
        {
          key_id: 'key-001',
          ciphertext: 'data',
          key_version: 1,
          iv: 'iv',
          tenant_id: TEST_TENANT_ID,
          correlation_id: TEST_CORRELATION_ID,
        },
        ctx,
      );

      expect(auditEmitter.events).toHaveLength(1);
      expect(auditEmitter.events[0]!.payload).toMatchObject({
        event_type: 'key.decrypt',
        key_id: 'key-001',
      });
    });
  });
});

// ─── RotationScheduler Tests ─────────────────────────────────────────────────

describe('RotationScheduler', () => {
  let scheduler: RotationScheduler;
  let service: SecretsService;
  let kmsProvider: MockKMSProvider;
  let keyStore: InMemoryKeyVersionStore;
  let clock: MockClock;
  let auditEmitter: MockAuditEmitter;
  let revocationPropagator: MockRevocationPropagator;
  let ctx: RequestContext;

  beforeEach(() => {
    kmsProvider = new MockKMSProvider();
    keyStore = new InMemoryKeyVersionStore();
    clock = new MockClock();
    auditEmitter = new MockAuditEmitter();
    revocationPropagator = new MockRevocationPropagator();

    service = new SecretsService({
      kmsProvider,
      keyStore,
      clock,
      auditEmitter,
      revocationPropagator,
    });

    scheduler = new RotationScheduler({
      secretsService: service,
      keyStore,
      clock,
    });

    ctx = createCtx();
  });

  it('identifies symmetric keys due for rotation after 90 days', () => {
    // Key rotated 91 days ago
    const key = createKeyMetadata({
      rotated_at: '2024-03-01T00:00:00.000Z' as ISOTimestamp,
    });

    const result = scheduler.checkKey(key);

    expect(result.needs_rotation).toBe(true);
    expect(result.age_days).toBeGreaterThanOrEqual(90);
    expect(result.max_age_days).toBe(90);
  });

  it('identifies asymmetric keys due for rotation after 365 days', () => {
    // Asymmetric key rotated 366 days ago
    clock.setTime(new Date('2025-06-01T00:00:00.000Z'));
    const key = createKeyMetadata({
      key_type: 'asymmetric',
      algorithm: 'RSA-OAEP-256',
      rotated_at: '2024-06-01T00:00:00.000Z' as ISOTimestamp,
    });

    const result = scheduler.checkKey(key);

    expect(result.needs_rotation).toBe(true);
    expect(result.max_age_days).toBe(365);
  });

  it('does not flag keys that are not yet due', () => {
    // Key rotated today
    const key = createKeyMetadata({
      rotated_at: clock.nowISO() as ISOTimestamp,
    });

    const result = scheduler.checkKey(key);

    expect(result.needs_rotation).toBe(false);
    expect(result.days_remaining).toBe(90);
  });

  it('scanAndRotate rotates due keys and reports results', async () => {
    // Seed a key that's overdue for rotation
    keyStore.seed(createKeyMetadata({
      rotated_at: '2024-01-01T00:00:00.000Z' as ISOTimestamp,
    }));

    const result = await scheduler.scanAndRotate(TEST_TENANT_ID, ctx);

    expect(result.tenant_id).toBe(TEST_TENANT_ID);
    expect(result.due_for_rotation.length).toBeGreaterThanOrEqual(1);
    expect(result.rotated).toContain('key-001');
    expect(result.failed).toHaveLength(0);
  });
});

// ─── RevocationPropagator Tests ──────────────────────────────────────────────

describe('RevocationPropagatorImpl', () => {
  let propagator: RevocationPropagatorImpl;

  beforeEach(() => {
    propagator = new RevocationPropagatorImpl({ perConsumerTimeoutMs: 1000, maxRetries: 1 });
  });

  it('notifies all registered consumers', async () => {
    const notified: string[] = [];

    propagator.registerConsumer({
      id: 'consumer-1',
      name: 'Service A',
      onRevocation: async (keyId) => { notified.push(`A:${keyId}`); },
    });
    propagator.registerConsumer({
      id: 'consumer-2',
      name: 'Service B',
      onRevocation: async (keyId) => { notified.push(`B:${keyId}`); },
    });

    const count = await propagator.propagate('key-001', 'tenant-001', 'compromised');

    expect(count).toBe(2);
    expect(notified).toContain('A:key-001');
    expect(notified).toContain('B:key-001');
  });

  it('returns 0 when no consumers are registered', async () => {
    const count = await propagator.propagate('key-001', 'tenant-001', 'test');
    expect(count).toBe(0);
  });

  it('handles consumer failures gracefully', async () => {
    propagator.registerConsumer({
      id: 'failing-consumer',
      name: 'Failing Service',
      onRevocation: async () => { throw new Error('connection refused'); },
    });
    propagator.registerConsumer({
      id: 'working-consumer',
      name: 'Working Service',
      onRevocation: async () => { /* success */ },
    });

    const count = await propagator.propagate('key-001', 'tenant-001', 'test');

    // Only the working consumer should be counted
    expect(count).toBe(1);
  });

  it('tracks notification log', async () => {
    propagator.registerConsumer({
      id: 'consumer-1',
      name: 'Service A',
      onRevocation: async () => { /* success */ },
    });

    await propagator.propagate('key-001', 'tenant-001', 'test');

    const log = propagator.getNotificationLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.success).toBe(true);
    expect(log[0]!.consumer_id).toBe('consumer-1');
  });

  it('unregisters consumers', () => {
    propagator.registerConsumer({
      id: 'consumer-1',
      name: 'Service A',
      onRevocation: async () => { /* noop */ },
    });

    expect(propagator.consumerCount).toBe(1);
    propagator.unregisterConsumer('consumer-1');
    expect(propagator.consumerCount).toBe(0);
  });
});

// ─── InMemoryKMSProvider Tests ───────────────────────────────────────────────

describe('InMemoryKMSProvider', () => {
  let kms: InMemoryKMSProvider;

  beforeEach(() => {
    kms = new InMemoryKMSProvider();
  });

  it('creates keys and returns unique references', async () => {
    const ref1 = await kms.createKey({
      key_type: 'symmetric',
      algorithm: 'AES-256-GCM',
      purpose: 'encryption',
      tenant_id: 'tenant-001',
    });
    const ref2 = await kms.createKey({
      key_type: 'symmetric',
      algorithm: 'AES-256-GCM',
      purpose: 'encryption',
      tenant_id: 'tenant-001',
    });

    expect(ref1).not.toBe(ref2);
    expect(kms.keyCount).toBe(2);
  });

  it('encrypts and decrypts data correctly', async () => {
    const ref = await kms.createKey({
      key_type: 'symmetric',
      algorithm: 'AES-256-GCM',
      purpose: 'encryption',
      tenant_id: 'tenant-001',
    });

    const plaintext = Buffer.from('hello world').toString('base64');
    const encrypted = await kms.encrypt(ref, plaintext);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.auth_tag).toBeDefined();

    const decrypted = await kms.decrypt(
      ref,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.auth_tag,
    );

    expect(decrypted.plaintext).toBe(plaintext);
  });

  it('encrypts and decrypts with AAD', async () => {
    const ref = await kms.createKey({
      key_type: 'symmetric',
      algorithm: 'AES-256-GCM',
      purpose: 'encryption',
      tenant_id: 'tenant-001',
    });

    const plaintext = Buffer.from('secret data').toString('base64');
    const encrypted = await kms.encrypt(ref, plaintext, 'additional-context');

    const decrypted = await kms.decrypt(
      ref,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.auth_tag,
      'additional-context',
    );

    expect(decrypted.plaintext).toBe(plaintext);
  });

  it('rotates keys and returns new reference', async () => {
    const ref = await kms.createKey({
      key_type: 'symmetric',
      algorithm: 'AES-256-GCM',
      purpose: 'encryption',
      tenant_id: 'tenant-001',
    });

    const newRef = await kms.rotateKey(ref);

    expect(newRef).not.toBe(ref);
    expect(kms.isKeyActive(ref)).toBe(true);
    expect(kms.isKeyActive(newRef)).toBe(true);
  });

  it('revokes keys making them unusable', async () => {
    const ref = await kms.createKey({
      key_type: 'symmetric',
      algorithm: 'AES-256-GCM',
      purpose: 'encryption',
      tenant_id: 'tenant-001',
    });

    await kms.revokeKey(ref);

    expect(kms.isKeyActive(ref)).toBe(false);
    await expect(
      kms.encrypt(ref, Buffer.from('test').toString('base64')),
    ).rejects.toThrow('not active');
  });

  it('throws on operations with non-existent keys', async () => {
    await expect(kms.encrypt('nonexistent', 'data')).rejects.toThrow('not found');
    await expect(kms.rotateKey('nonexistent')).rejects.toThrow('not found');
  });
});

// ─── InMemoryKeyVersionStore Tests ───────────────────────────────────────────

describe('InMemoryKeyVersionStore', () => {
  let store: InMemoryKeyVersionStore;

  beforeEach(() => {
    store = new InMemoryKeyVersionStore();
  });

  it('saves and retrieves key metadata', async () => {
    const metadata = createKeyMetadata();
    await store.save(metadata);

    const result = await store.get('key-001', TEST_TENANT_ID);
    expect(result).toEqual(metadata);
  });

  it('returns null for non-existent keys', async () => {
    const result = await store.get('nonexistent', TEST_TENANT_ID);
    expect(result).toBeNull();
  });

  it('retrieves specific version', async () => {
    await store.save(createKeyMetadata({ version: 1 }));
    await store.save(createKeyMetadata({ version: 2, kms_key_ref: 'ref-2' }));

    const v1 = await store.get('key-001', TEST_TENANT_ID, 1);
    const v2 = await store.get('key-001', TEST_TENANT_ID, 2);

    expect(v1!.version).toBe(1);
    expect(v2!.version).toBe(2);
  });

  it('returns latest active version by default', async () => {
    await store.save(createKeyMetadata({ version: 1, status: 'expired' }));
    await store.save(createKeyMetadata({ version: 2, status: 'active' }));

    const result = await store.get('key-001', TEST_TENANT_ID);
    expect(result!.version).toBe(2);
  });

  it('getAllVersions returns all versions sorted descending', async () => {
    await store.save(createKeyMetadata({ version: 1 }));
    await store.save(createKeyMetadata({ version: 3 }));
    await store.save(createKeyMetadata({ version: 2 }));

    const versions = await store.getAllVersions('key-001', TEST_TENANT_ID);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('updateStatus changes key status', async () => {
    await store.save(createKeyMetadata({ version: 1, status: 'active' }));

    await store.updateStatus('key-001', TEST_TENANT_ID, 1, 'revoked');

    const result = await store.get('key-001', TEST_TENANT_ID, 1);
    expect(result!.status).toBe('revoked');
  });

  it('delete removes a specific version', async () => {
    await store.save(createKeyMetadata({ version: 1 }));
    await store.save(createKeyMetadata({ version: 2 }));

    await store.delete('key-001', TEST_TENANT_ID, 1);

    const versions = await store.getAllVersions('key-001', TEST_TENANT_ID);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(2);
  });

  it('getKeysNeedingRotation returns overdue keys', async () => {
    const now = new Date('2024-06-01T00:00:00.000Z');
    // Key rotated 91 days ago
    await store.save(createKeyMetadata({
      rotated_at: '2024-03-01T00:00:00.000Z' as ISOTimestamp,
    }));

    const results = await store.getKeysNeedingRotation(
      TEST_TENANT_ID,
      { symmetric_max_age_days: 90, asymmetric_max_age_days: 365, max_versions_retained: 2 },
      now,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.key_id).toBe('key-001');
  });

  it('isolates keys by tenant', async () => {
    await store.save(createKeyMetadata({ tenant_id: 'tenant-A' as TenantId }));
    await store.save(createKeyMetadata({ key_id: 'key-002', tenant_id: 'tenant-B' as TenantId }));

    const resultA = await store.get('key-001', 'tenant-A');
    const resultB = await store.get('key-001', 'tenant-B');

    expect(resultA).not.toBeNull();
    expect(resultB).toBeNull();
  });
});
