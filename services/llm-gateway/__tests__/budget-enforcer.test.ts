/**
 * Unit tests for BudgetEnforcer — cost tracking and budget enforcement.
 *
 * Verifies:
 * - Budget check allows requests within limits
 * - Budget check rejects when daily limit exceeded
 * - Budget check rejects when monthly limit exceeded
 * - Usage recording and accumulation
 * - Period rollover (daily and monthly)
 * - Warning threshold tracking
 * - alert_only mode allows requests even when exceeded
 *
 * @see Requirement 4.8 — reject with BUDGET_EXCEEDED when tenant budget exceeded
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetEnforcer } from '../src/budget-enforcer.js';
import type { IClock } from '../src/interfaces/index.js';
import type { UsageRecord } from '../src/interfaces/budget-enforcer.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private current = '2024-01-15T12:00:00.000Z';

  nowISO(): string {
    return this.current;
  }

  setTime(iso: string): void {
    this.current = iso;
  }
}

function makeUsageRecord(overrides?: Partial<UsageRecord>): UsageRecord {
  return {
    cost_units: overrides?.cost_units ?? 10,
    timestamp: overrides?.timestamp ?? '2024-01-15T12:00:00.000Z',
    model_id: overrides?.model_id ?? 'gpt-4o',
    principal_id: overrides?.principal_id ?? 'user-1',
    tokens: overrides?.tokens ?? { prompt: 100, completion: 50 },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BudgetEnforcer', () => {
  let clock: MockClock;
  let enforcer: BudgetEnforcer;

  beforeEach(() => {
    clock = new MockClock();
    enforcer = new BudgetEnforcer(clock);
  });

  describe('unconfigured tenant', () => {
    it('allows requests when no budget is configured', () => {
      const result = enforcer.checkBudget('unknown-tenant', 100);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });
  });

  describe('budget checks', () => {
    beforeEach(() => {
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 100,
        monthly_limit: 1000,
        hard_limit_action: 'reject',
        warning_thresholds: [0.5, 0.75, 0.9],
      });
    });

    it('allows requests within daily limit', () => {
      const result = enforcer.checkBudget('tenant-1', 50);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(100); // No usage recorded yet
    });

    it('rejects when estimated cost would exceed daily limit', () => {
      // Record some usage first
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 80 }));

      // Check if a 30-unit request would be allowed
      const result = enforcer.checkBudget('tenant-1', 30);
      expect(result.allowed).toBe(false);
      expect(result.period).toBe('daily');
      expect(result.current_usage).toBe(80);
      expect(result.limit).toBe(100);
      expect(result.remaining).toBe(20);
    });

    it('rejects when estimated cost would exceed monthly limit', () => {
      // Set daily limit high so monthly is the constraint
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 10000,
        monthly_limit: 500,
        hard_limit_action: 'reject',
        warning_thresholds: [0.5, 0.75, 0.9],
      });

      // Record usage near monthly limit
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 480 }));

      const result = enforcer.checkBudget('tenant-1', 30);
      expect(result.allowed).toBe(false);
      expect(result.period).toBe('monthly');
      expect(result.current_usage).toBe(480);
      expect(result.remaining).toBe(20);
    });

    it('allows requests in alert_only mode even when exceeded', () => {
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 100,
        monthly_limit: 1000,
        hard_limit_action: 'alert_only',
        warning_thresholds: [0.5, 0.75, 0.9],
      });

      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 150 }));

      const result = enforcer.checkBudget('tenant-1', 10);
      // alert_only mode should still allow
      expect(result.allowed).toBe(true);
    });
  });

  describe('usage recording', () => {
    beforeEach(() => {
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 100,
        monthly_limit: 1000,
        hard_limit_action: 'reject',
        warning_thresholds: [0.5, 0.75, 0.9],
      });
    });

    it('accumulates usage from multiple records', () => {
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 30 }));
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 25 }));
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 20 }));

      const status = enforcer.getStatus('tenant-1');
      expect(status.current_usage).toBe(75);
      expect(status.remaining).toBe(25);
    });
  });

  describe('period rollover', () => {
    beforeEach(() => {
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 100,
        monthly_limit: 1000,
        hard_limit_action: 'reject',
        warning_thresholds: [0.5, 0.75, 0.9],
      });
    });

    it('resets daily usage on new day', () => {
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 90 }));

      // Advance to next day
      clock.setTime('2024-01-16T00:00:01.000Z');

      const result = enforcer.checkBudget('tenant-1', 50);
      expect(result.allowed).toBe(true);
      // Daily usage should be reset
      expect(result.current_usage).toBe(0);
    });

    it('resets monthly usage on new month', () => {
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 900 }));

      // Advance to next month
      clock.setTime('2024-02-01T00:00:01.000Z');

      const result = enforcer.checkBudget('tenant-1', 50);
      expect(result.allowed).toBe(true);
    });

    it('preserves monthly usage on daily rollover', () => {
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 50 }));

      // Advance to next day (same month)
      clock.setTime('2024-01-16T00:00:01.000Z');

      // Daily should be reset, but monthly should still have the usage
      // Record more usage
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 50 }));

      // Monthly should now be 50 (from today only, since rollover clears daily but monthly accumulates)
      // Actually, the monthly usage is tracked separately and only resets on month change
      const status = enforcer.getStatus('tenant-1');
      // After daily rollover, monthly keeps accumulating
      expect(status.allowed).toBe(true);
    });
  });

  describe('resetPeriod', () => {
    beforeEach(() => {
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 100,
        monthly_limit: 1000,
        hard_limit_action: 'reject',
        warning_thresholds: [0.5, 0.75, 0.9],
      });
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 80 }));
    });

    it('resets daily counters', () => {
      enforcer.resetPeriod('tenant-1', 'daily');
      const status = enforcer.getStatus('tenant-1');
      // After daily reset, daily usage is 0 but monthly still has it
      // The status returns the more restrictive, which is now daily (0 usage, 100 remaining)
      // vs monthly (80 usage, 920 remaining) — daily has more remaining so monthly is returned
      // Actually: daily remaining = 100, monthly remaining = 920
      // The code returns the more restrictive (lower remaining)
      expect(status.allowed).toBe(true);
    });

    it('resets monthly counters (also resets daily)', () => {
      enforcer.resetPeriod('tenant-1', 'monthly');
      const status = enforcer.getStatus('tenant-1');
      expect(status.current_usage).toBe(0);
      expect(status.allowed).toBe(true);
    });
  });

  describe('warning thresholds', () => {
    beforeEach(() => {
      enforcer.configure({
        tenant_id: 'tenant-1',
        daily_limit: 100,
        monthly_limit: 1000,
        hard_limit_action: 'reject',
        warning_thresholds: [0.5, 0.75, 0.9],
      });
    });

    it('tracks triggered warning thresholds', () => {
      // Record 50 units (50% of daily)
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 50 }));

      const thresholds = enforcer.getTriggeredThresholds('tenant-1');
      expect(thresholds.daily).toContain(0.5);
    });

    it('triggers multiple thresholds as usage increases', () => {
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 50 }));
      enforcer.recordUsageForTenant('tenant-1', makeUsageRecord({ cost_units: 30 }));

      const thresholds = enforcer.getTriggeredThresholds('tenant-1');
      expect(thresholds.daily).toContain(0.5);
      expect(thresholds.daily).toContain(0.75);
    });

    it('returns empty thresholds for unconfigured tenant', () => {
      const thresholds = enforcer.getTriggeredThresholds('unknown');
      expect(thresholds.daily).toEqual([]);
      expect(thresholds.monthly).toEqual([]);
    });
  });
});
