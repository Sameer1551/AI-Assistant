/**
 * Property-Based Tests — Cost Service
 *
 * Property 43: Usage Attribution — every billable event correctly attributed to tenant_id and principal_id
 * Property 44: Budget Alert Emission — warning alert emitted at configured thresholds
 *
 * @see Requirements 34.1, 34.2
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CostService,
  InMemoryCostEventStore,
  InMemoryBudgetConfigStore,
} from '../src/cost-service.js';
import type { BudgetAlertEvent } from '../src/cost-service.js';
import type { UsageEvent, BudgetConfig } from '@may/types';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

let idCounter = 0;
const mockIdGen = { uuid: () => `cost-${++idCounter}` };
const NOW = '2025-06-15T14:30:00.000Z';
const mockClock = {
  nowISO: () => NOW,
  startOfDay: () => '2025-06-15T00:00:00.000Z',
  endOfDay: () => '2025-06-15T23:59:59.999Z',
  startOfMonth: () => '2025-06-01T00:00:00.000Z',
  endOfMonth: () => '2025-06-30T23:59:59.999Z',
};

function makeEvent(tenantId: string, principalId: string, costUnits: number, resourceType: 'model_invocation' | 'sandbox_execution' | 'storage' = 'model_invocation'): UsageEvent {
  return {
    event_id: `evt-${++idCounter}`,
    tenant_id: tenantId,
    principal_id: principalId,
    resource_type: resourceType,
    cost_units: costUnits,
    timestamp: NOW,
  };
}

function makeService(alerts?: BudgetAlertEvent[]) {
  const eventStore = new InMemoryCostEventStore();
  const budgetStore = new InMemoryBudgetConfigStore();
  const alertEmitter = {
    async emitBudgetAlert(alert: BudgetAlertEvent) {
      alerts?.push(alert);
    },
  };
  const service = new CostService({
    eventStore,
    budgetStore,
    alertEmitter,
    idGenerator: mockIdGen,
    clock: mockClock,
  });
  return { service, eventStore, budgetStore };
}

// ─── Property 43: Usage Attribution ──────────────────────────────────────────

describe('Property 43: Usage Attribution', () => {
  it('every event is attributed to the correct tenant_id and principal_id', async () => {
    const { service, eventStore } = makeService();

    const event = makeEvent('tenantA', 'user1', 5);
    await service.recordUsage(event);

    const stored = await eventStore.findByTenant('tenantA', mockClock.startOfDay(), mockClock.endOfDay());
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tenant_id).toBe('tenantA');
    expect(stored[0]!.principal_id).toBe('user1');
    expect(stored[0]!.cost_units).toBe(5);
  });

  it('events from different tenants are properly separated', async () => {
    const { service, eventStore } = makeService();

    await service.recordUsage(makeEvent('tenantA', 'u1', 10));
    await service.recordUsage(makeEvent('tenantB', 'u2', 20));

    const tenantAEvents = await eventStore.findByTenant('tenantA', mockClock.startOfDay(), mockClock.endOfDay());
    const tenantBEvents = await eventStore.findByTenant('tenantB', mockClock.startOfDay(), mockClock.endOfDay());

    expect(tenantAEvents).toHaveLength(1);
    expect(tenantBEvents).toHaveLength(1);
    expect(tenantAEvents[0]!.tenant_id).toBe('tenantA');
    expect(tenantBEvents[0]!.tenant_id).toBe('tenantB');
  });

  it('throws when tenant_id is missing from usage event', async () => {
    const { service } = makeService();
    const badEvent = { ...makeEvent('', 'user1', 5) };
    await expect(service.recordUsage(badEvent)).rejects.toThrow('ATTRIBUTION_REQUIRED');
  });

  it('throws when principal_id is missing from usage event', async () => {
    const { service } = makeService();
    const badEvent = { ...makeEvent('tenant1', '', 5) };
    await expect(service.recordUsage(badEvent)).rejects.toThrow('ATTRIBUTION_REQUIRED');
  });

  it('cost report correctly aggregates by resource type', async () => {
    const { service } = makeService();

    await service.recordUsage(makeEvent('t1', 'u1', 10, 'model_invocation'));
    await service.recordUsage(makeEvent('t1', 'u1', 5, 'sandbox_execution'));
    await service.recordUsage(makeEvent('t1', 'u1', 2, 'storage'));

    const report = await service.getCostReport('t1', 'u1', mockClock.startOfDay(), mockClock.endOfDay());

    expect(report.total_cost_units).toBe(17);
    expect(report.breakdown_by_resource['model_invocation']).toBe(10);
    expect(report.breakdown_by_resource['sandbox_execution']).toBe(5);
    expect(report.breakdown_by_resource['storage']).toBe(2);
  });
});

// ─── Property 44: Budget Alert Emission ──────────────────────────────────────

describe('Property 44: Budget Alert Emission', () => {
  it('warning alert emitted when usage crosses a threshold', async () => {
    const alerts: BudgetAlertEvent[] = [];
    const { service, budgetStore } = makeService(alerts);

    const budget: BudgetConfig = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      daily_limit: 100,
      monthly_limit: 1000,
      warning_thresholds: [0.5, 0.75, 0.9],
      hard_limit_action: 'reject',
    };
    await budgetStore.saveBudget(budget);

    // Use 60% of daily limit → should trigger 0.5 threshold alert
    await service.recordUsage(makeEvent('tenant-1', 'user-1', 60));

    const dailyAlerts = alerts.filter((a) => a.period === 'daily');
    expect(dailyAlerts.length).toBeGreaterThan(0);
    const triggeredThresholds = dailyAlerts.map((a) => a.threshold_fraction);
    expect(triggeredThresholds).toContain(0.5);
  });

  it('alert contains correct attribution fields', async () => {
    const alerts: BudgetAlertEvent[] = [];
    const { service, budgetStore } = makeService(alerts);

    const budget: BudgetConfig = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      daily_limit: 100,
      monthly_limit: 1000,
      warning_thresholds: [0.5],
      hard_limit_action: 'alert_only',
    };
    await budgetStore.saveBudget(budget);
    await service.recordUsage(makeEvent('tenant-1', 'user-1', 60));

    const alert = alerts.find((a) => a.period === 'daily');
    expect(alert?.tenant_id).toBe('tenant-1');
    expect(alert?.principal_id).toBe('user-1');
    expect(alert?.alert_id).toBeDefined();
    expect(alert?.timestamp).toBeDefined();
  });

  it('budget is exceeded when hard limit is reached', async () => {
    const { service, budgetStore } = makeService();

    await budgetStore.saveBudget({
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      daily_limit: 50,
      monthly_limit: 500,
      warning_thresholds: [],
      hard_limit_action: 'reject',
    });

    // Exceed the daily limit
    await service.recordUsage(makeEvent('tenant-1', 'user-1', 60));

    const exceeded = await service.isBudgetExceeded('tenant-1', 'user-1');
    expect(exceeded).toBe(true);
  });

  it('budget not exceeded in alert_only mode even over limit', async () => {
    const { service, budgetStore } = makeService();

    await budgetStore.saveBudget({
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      daily_limit: 10,
      monthly_limit: 100,
      warning_thresholds: [],
      hard_limit_action: 'alert_only',
    });

    await service.recordUsage(makeEvent('tenant-1', 'user-1', 999));

    const exceeded = await service.isBudgetExceeded('tenant-1', 'user-1');
    expect(exceeded).toBe(false); // alert_only → never reject
  });
});
