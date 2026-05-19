/**
 * Unit tests for InMemoryTenantPolicyStore.
 *
 * Verifies:
 * - Policy storage and retrieval
 * - Policy updates
 * - Missing policy handling
 * - Cleanup operations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTenantPolicyStore } from '../src/in-memory-tenant-policy-store.js';
import type { TenantRedactionPolicy } from '../src/interfaces/index.js';

describe('InMemoryTenantPolicyStore', () => {
  let store: InMemoryTenantPolicyStore;

  const samplePolicy: TenantRedactionPolicy = {
    policy: {
      categories: ['email', 'phone', 'payment_card'],
      confidence_threshold: 0.90,
      posture: 'redact',
    },
    version: 'v1.0.0',
    updated_at: '2024-01-15T00:00:00.000Z',
  };

  beforeEach(() => {
    store = new InMemoryTenantPolicyStore();
  });

  it('should return null for unknown tenant', async () => {
    const result = await store.getRedactionPolicy('unknown-tenant');
    expect(result).toBeNull();
  });

  it('should store and retrieve a policy', async () => {
    await store.setRedactionPolicy('tenant-1', samplePolicy);
    const result = await store.getRedactionPolicy('tenant-1');

    expect(result).toEqual(samplePolicy);
  });

  it('should update an existing policy', async () => {
    await store.setRedactionPolicy('tenant-1', samplePolicy);

    const updatedPolicy: TenantRedactionPolicy = {
      ...samplePolicy,
      version: 'v2.0.0',
      policy: { ...samplePolicy.policy, posture: 'block' },
    };

    await store.setRedactionPolicy('tenant-1', updatedPolicy);
    const result = await store.getRedactionPolicy('tenant-1');

    expect(result!.version).toBe('v2.0.0');
    expect(result!.policy.posture).toBe('block');
  });

  it('should isolate policies between tenants', async () => {
    const policy2: TenantRedactionPolicy = {
      ...samplePolicy,
      version: 'v3.0.0',
    };

    await store.setRedactionPolicy('tenant-1', samplePolicy);
    await store.setRedactionPolicy('tenant-2', policy2);

    const result1 = await store.getRedactionPolicy('tenant-1');
    const result2 = await store.getRedactionPolicy('tenant-2');

    expect(result1!.version).toBe('v1.0.0');
    expect(result2!.version).toBe('v3.0.0');
  });

  it('should remove a policy', async () => {
    await store.setRedactionPolicy('tenant-1', samplePolicy);
    await store.removeRedactionPolicy('tenant-1');

    const result = await store.getRedactionPolicy('tenant-1');
    expect(result).toBeNull();
  });

  it('should clear all policies', async () => {
    await store.setRedactionPolicy('tenant-1', samplePolicy);
    await store.setRedactionPolicy('tenant-2', samplePolicy);
    await store.clear();

    expect(await store.getRedactionPolicy('tenant-1')).toBeNull();
    expect(await store.getRedactionPolicy('tenant-2')).toBeNull();
  });
});
