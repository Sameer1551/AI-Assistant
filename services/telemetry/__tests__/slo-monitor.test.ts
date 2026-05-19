/**
 * Unit tests for SLOMonitor.
 *
 * Verifies:
 * - SLO registration and status computation
 * - Error budget calculation
 * - Budget-warning alert at 25% remaining
 * - High-severity alert on SLO breach
 * - Alert deduplication (only emit once per condition)
 *
 * @see Requirement 18.1 - SLO definitions
 * @see Requirement 18.3 - Compute every ≤5 min
 * @see Requirement 18.4 - Budget-warning at 25% remaining
 * @see Requirement 18.5 - High-severity on breach
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SLOMonitor } from '../src/slo-monitor.js';
import type { SLODefinition } from '../src/interfaces/index.js';

const LLM_GATEWAY_SLO: SLODefinition = {
  slo_id: 'llm-gateway-availability',
  service_name: 'LLM_Gateway',
  name: 'LLM Gateway Availability',
  sli_type: 'availability',
  target: 0.999, // 99.9%
  window_days: 30,
};

const VOICE_LATENCY_SLO: SLODefinition = {
  slo_id: 'voice-latency',
  service_name: 'Voice_Service',
  name: 'Voice Service Latency',
  sli_type: 'latency',
  target: 0.95, // 95% of requests under threshold
  window_days: 7,
};

describe('SLOMonitor', () => {
  let monitor: SLOMonitor;

  beforeEach(() => {
    monitor = new SLOMonitor();
    monitor.registerSLO(LLM_GATEWAY_SLO);
    monitor.registerSLO(VOICE_LATENCY_SLO);
  });

  describe('SLO registration', () => {
    it('should throw for unregistered SLO', () => {
      expect(() => monitor.computeStatus('nonexistent')).toThrow('SLO not registered');
    });

    it('should compute status for registered SLO', () => {
      const status = monitor.computeStatus('llm-gateway-availability');
      expect(status.definition).toEqual(LLM_GATEWAY_SLO);
    });
  });

  describe('status computation with no observations', () => {
    it('should report SLO as met with no observations', () => {
      const status = monitor.computeStatus('llm-gateway-availability');

      expect(status.is_met).toBe(true);
      expect(status.current_sli).toBe(1.0);
      expect(status.error_budget_remaining).toBe(1.0);
    });

    it('should include computed_at timestamp', () => {
      const status = monitor.computeStatus('llm-gateway-availability');
      expect(status.computed_at).toBeDefined();
      expect(new Date(status.computed_at).getTime()).toBeGreaterThan(0);
    });
  });

  describe('error budget computation', () => {
    it('should compute error budget total as 1 - target', () => {
      const status = monitor.computeStatus('llm-gateway-availability');
      // 99.9% target → 0.001 error budget
      expect(status.error_budget_total).toBeCloseTo(0.001);
    });

    it('should track error budget consumption', () => {
      // Record 1000 observations, 999 successful (99.9% = exactly at target)
      for (let i = 0; i < 999; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      monitor.recordObservation('llm-gateway-availability', false);

      const status = monitor.computeStatus('llm-gateway-availability');
      // 1 failure out of 1000 = 0.001 error rate = budget fully consumed
      expect(status.error_budget_consumed).toBeCloseTo(0.001);
      expect(status.error_budget_remaining).toBeCloseTo(0, 1);
    });

    it('should show full budget remaining when all requests succeed', () => {
      for (let i = 0; i < 100; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }

      const status = monitor.computeStatus('llm-gateway-availability');
      expect(status.error_budget_remaining).toBe(1.0);
      expect(status.error_budget_consumed).toBe(0);
    });

    it('should show budget depleted when error rate exceeds target', () => {
      // 99.9% target, but only 99% success (10 failures out of 1000)
      for (let i = 0; i < 990; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 10; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      const status = monitor.computeStatus('llm-gateway-availability');
      // Error rate = 0.01, budget = 0.001, consumed > budget
      expect(status.is_met).toBe(false);
      expect(status.error_budget_remaining).toBe(0);
    });
  });

  describe('budget-warning alert (Requirement 18.4)', () => {
    it('should emit budget-warning when remaining drops below 25%', () => {
      // For 99.9% target (budget = 0.001):
      // Need error rate > 0.00075 to consume >75% of budget
      // With 10000 requests, need > 7.5 failures to trigger
      // Let's use 8 failures out of 10000 → error rate = 0.0008
      for (let i = 0; i < 9992; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 8; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      monitor.computeStatus('llm-gateway-availability');
      const alerts = monitor.getAlerts();

      const budgetWarnings = alerts.filter(a => a.type === 'budget_warning');
      expect(budgetWarnings.length).toBe(1);
      expect(budgetWarnings[0].severity).toBe('warning');
      expect(budgetWarnings[0].slo_id).toBe('llm-gateway-availability');
      expect(budgetWarnings[0].service_name).toBe('LLM_Gateway');
    });

    it('should not emit budget-warning when budget is healthy', () => {
      for (let i = 0; i < 1000; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }

      monitor.computeStatus('llm-gateway-availability');
      const alerts = monitor.getAlerts();

      expect(alerts.filter(a => a.type === 'budget_warning')).toHaveLength(0);
    });

    it('should emit budget-warning only once per window', () => {
      // Trigger warning condition
      for (let i = 0; i < 9992; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 8; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      // Compute multiple times
      monitor.computeStatus('llm-gateway-availability');
      monitor.computeStatus('llm-gateway-availability');
      monitor.computeStatus('llm-gateway-availability');

      const alerts = monitor.getAlerts();
      const budgetWarnings = alerts.filter(a => a.type === 'budget_warning');
      expect(budgetWarnings.length).toBe(1);
    });
  });

  describe('SLO breach alert (Requirement 18.5)', () => {
    it('should emit high-severity alert on SLO breach', () => {
      // Breach: error rate exceeds budget
      for (let i = 0; i < 990; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 10; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      monitor.computeStatus('llm-gateway-availability');
      const alerts = monitor.getAlerts();

      const breachAlerts = alerts.filter(a => a.type === 'slo_breach');
      expect(breachAlerts.length).toBe(1);
      expect(breachAlerts[0].severity).toBe('high');
      expect(breachAlerts[0].slo_id).toBe('llm-gateway-availability');
    });

    it('should not emit breach alert when SLO is met', () => {
      for (let i = 0; i < 1000; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }

      monitor.computeStatus('llm-gateway-availability');
      const alerts = monitor.getAlerts();

      expect(alerts.filter(a => a.type === 'slo_breach')).toHaveLength(0);
    });

    it('should emit breach alert only once', () => {
      for (let i = 0; i < 990; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 10; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      monitor.computeStatus('llm-gateway-availability');
      monitor.computeStatus('llm-gateway-availability');

      const alerts = monitor.getAlerts();
      const breachAlerts = alerts.filter(a => a.type === 'slo_breach');
      expect(breachAlerts.length).toBe(1);
    });
  });

  describe('alert management', () => {
    it('should clear alerts when requested', () => {
      for (let i = 0; i < 990; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 10; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      monitor.computeStatus('llm-gateway-availability');
      expect(monitor.getAlerts().length).toBeGreaterThan(0);

      monitor.clearAlerts();
      expect(monitor.getAlerts()).toHaveLength(0);
    });

    it('should include all required alert fields', () => {
      for (let i = 0; i < 990; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }
      for (let i = 0; i < 10; i++) {
        monitor.recordObservation('llm-gateway-availability', false);
      }

      monitor.computeStatus('llm-gateway-availability');
      const alerts = monitor.getAlerts();

      for (const alert of alerts) {
        expect(alert.alert_id).toBeDefined();
        expect(alert.severity).toBeDefined();
        expect(alert.type).toBeDefined();
        expect(alert.slo_id).toBeDefined();
        expect(alert.service_name).toBeDefined();
        expect(alert.message).toBeDefined();
        expect(alert.error_budget_remaining).toBeDefined();
        expect(alert.emitted_at).toBeDefined();
      }
    });
  });

  describe('multiple SLOs', () => {
    it('should track SLOs independently', () => {
      // LLM Gateway: healthy
      for (let i = 0; i < 100; i++) {
        monitor.recordObservation('llm-gateway-availability', true);
      }

      // Voice: breached
      for (let i = 0; i < 80; i++) {
        monitor.recordObservation('voice-latency', true);
      }
      for (let i = 0; i < 20; i++) {
        monitor.recordObservation('voice-latency', false);
      }

      const llmStatus = monitor.computeStatus('llm-gateway-availability');
      const voiceStatus = monitor.computeStatus('voice-latency');

      expect(llmStatus.is_met).toBe(true);
      expect(voiceStatus.is_met).toBe(false);
    });
  });
});
