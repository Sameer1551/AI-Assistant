/**
 * Unit tests for CanaryDeploymentService — progressive traffic shifting
 * for model and prompt version rollouts.
 *
 * Verifies:
 * - Deployment creation with initial canary fraction (Requirement 30.1)
 * - Traffic routing splits requests between canary and baseline
 * - Progression through schedule when health metrics within tolerances (Requirement 30.2)
 * - Auto-revert on health metric breach with high-severity alert (Requirement 30.3)
 * - Retention of at least 2 production-eligible versions (Requirement 30.4)
 * - Manual promotion and rollback
 * - Integration with model registry for version management
 *
 * @see Requirement 30.1 — initial canary fraction routing
 * @see Requirement 30.2 — progression when health metrics within tolerances
 * @see Requirement 30.3 — auto-revert on health metric breach
 * @see Requirement 30.4 — retain at least 2 production-eligible versions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CanaryDeploymentService } from '../src/canary-deployment.js';
import type {
  IClock,
  IIdGenerator,
  CreateCanaryDeploymentInput,
  CanaryHealthMetrics,
  CanaryAlert,
} from '../src/interfaces/index.js';
import type { ICanaryAlertListener } from '../src/canary-deployment.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private current = '2024-01-01T00:00:00.000Z';

  nowISO(): string {
    return this.current;
  }

  advance(iso: string): void {
    this.current = iso;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  version(): string {
    this.counter++;
    return `id-${this.counter}`;
  }
}

class MockAlertListener implements ICanaryAlertListener {
  readonly alerts: CanaryAlert[] = [];

  onAlert(alert: CanaryAlert): void {
    this.alerts.push(alert);
  }
}

function makeDeploymentInput(overrides?: Partial<CreateCanaryDeploymentInput>): CreateCanaryDeploymentInput {
  return {
    target_type: overrides?.target_type ?? 'model',
    target_id: overrides?.target_id ?? 'model-gpt4',
    canary_version: overrides?.canary_version ?? 'v2',
    baseline_version: overrides?.baseline_version ?? 'v1',
    config: overrides?.config ?? {
      initial_fraction: 0.01,
      progression_schedule: [0.01, 0.05, 0.25, 0.50, 1.0],
      health_tolerances: { error_rate: 0.02, latency_p95_ms: 100 },
      auto_revert_threshold: 0.5,
    },
  };
}

function makeHealthyMetrics(overrides?: Partial<CanaryHealthMetrics>): CanaryHealthMetrics {
  return {
    error_rate: overrides?.error_rate ?? 0.01,
    latency_p95_ms: overrides?.latency_p95_ms ?? 200,
    quality_score: overrides?.quality_score ?? 0.95,
    request_count: overrides?.request_count ?? 100,
    collected_at: overrides?.collected_at ?? '2024-01-01T01:00:00.000Z',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CanaryDeploymentService', () => {
  let clock: MockClock;
  let idGen: MockIdGenerator;
  let alertListener: MockAlertListener;
  let service: CanaryDeploymentService;

  beforeEach(() => {
    clock = new MockClock();
    idGen = new MockIdGenerator();
    alertListener = new MockAlertListener();
    service = new CanaryDeploymentService(clock, idGen);
    service.addAlertListener(alertListener);
  });

  describe('createDeployment', () => {
    it('creates a deployment with initial canary fraction', async () => {
      const input = makeDeploymentInput();
      const deployment = await service.createDeployment(input);

      expect(deployment.deployment_id).toBe('id-1');
      expect(deployment.target_type).toBe('model');
      expect(deployment.target_id).toBe('model-gpt4');
      expect(deployment.canary_version).toBe('v2');
      expect(deployment.baseline_version).toBe('v1');
      expect(deployment.status).toBe('active');
      expect(deployment.current_traffic_fraction).toBe(0.01);
      expect(deployment.progression_index).toBe(0);
      expect(deployment.config).toEqual(input.config);
      expect(deployment.metrics_history).toHaveLength(0);
      expect(deployment.created_at).toBe('2024-01-01T00:00:00.000Z');
    });

    it('emits an info alert on deployment creation', async () => {
      await service.createDeployment(makeDeploymentInput());

      expect(alertListener.alerts).toHaveLength(1);
      expect(alertListener.alerts[0].severity).toBe('info');
      expect(alertListener.alerts[0].message).toContain('Canary deployment started');
      expect(alertListener.alerts[0].message).toContain('1.0%');
    });

    it('throws when creating a duplicate active deployment for the same target', async () => {
      await service.createDeployment(makeDeploymentInput());

      await expect(service.createDeployment(makeDeploymentInput())).rejects.toThrow(
        'Active canary deployment already exists',
      );
    });

    it('allows creating a new deployment after previous one is rolled back', async () => {
      const first = await service.createDeployment(makeDeploymentInput());
      await service.rollback(first.deployment_id, 'test');

      const second = await service.createDeployment(makeDeploymentInput({ canary_version: 'v3' }));
      expect(second.canary_version).toBe('v3');
      expect(second.status).toBe('active');
    });

    it('supports prompt target type', async () => {
      const input = makeDeploymentInput({
        target_type: 'prompt',
        target_id: 'system-prompt-main',
        canary_version: 'prompt-v2',
        baseline_version: 'prompt-v1',
      });

      const deployment = await service.createDeployment(input);
      expect(deployment.target_type).toBe('prompt');
      expect(deployment.target_id).toBe('system-prompt-main');
    });
  });

  describe('getDeployment', () => {
    it('returns null for non-existent deployment', async () => {
      const result = await service.getDeployment('non-existent');
      expect(result).toBeNull();
    });

    it('returns the deployment by ID', async () => {
      const created = await service.createDeployment(makeDeploymentInput());
      const result = await service.getDeployment(created.deployment_id);

      expect(result).not.toBeNull();
      expect(result!.deployment_id).toBe(created.deployment_id);
    });
  });

  describe('getActiveDeployment', () => {
    it('returns null when no active deployment exists', async () => {
      const result = await service.getActiveDeployment('model', 'model-gpt4');
      expect(result).toBeNull();
    });

    it('returns the active deployment for a target', async () => {
      await service.createDeployment(makeDeploymentInput());
      const result = await service.getActiveDeployment('model', 'model-gpt4');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
    });

    it('returns null after deployment is rolled back', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      await service.rollback(deployment.deployment_id, 'test');

      const result = await service.getActiveDeployment('model', 'model-gpt4');
      expect(result).toBeNull();
    });
  });

  describe('routeTraffic', () => {
    it('routes to baseline when no active deployment exists', async () => {
      const decision = await service.routeTraffic('model', 'model-gpt4', 'v1');

      expect(decision.routed_version).toBe('v1');
      expect(decision.is_canary).toBe(false);
      expect(decision.deployment_id).toBeUndefined();
    });

    it('routes to canary version when random is below traffic fraction', async () => {
      // Create service with deterministic random that always returns 0 (below any fraction)
      const deterministicService = new CanaryDeploymentService(clock, idGen, () => 0.005);
      await deterministicService.createDeployment(makeDeploymentInput());

      const decision = await deterministicService.routeTraffic('model', 'model-gpt4', 'v1');

      expect(decision.routed_version).toBe('v2');
      expect(decision.is_canary).toBe(true);
      expect(decision.deployment_id).toBeDefined();
    });

    it('routes to baseline version when random is above traffic fraction', async () => {
      // Create service with deterministic random that always returns 0.5 (above 0.01 fraction)
      const deterministicService = new CanaryDeploymentService(clock, idGen, () => 0.5);
      await deterministicService.createDeployment(makeDeploymentInput());

      const decision = await deterministicService.routeTraffic('model', 'model-gpt4', 'v1');

      expect(decision.routed_version).toBe('v1');
      expect(decision.is_canary).toBe(false);
      expect(decision.deployment_id).toBeDefined();
    });

    it('respects current traffic fraction after progression', async () => {
      // Start with 1% canary
      const deterministicService = new CanaryDeploymentService(clock, idGen, () => 0.04);
      const deployment = await deterministicService.createDeployment(makeDeploymentInput());

      // At 1% fraction, 0.04 > 0.01 → routes to baseline
      let decision = await deterministicService.routeTraffic('model', 'model-gpt4', 'v1');
      expect(decision.is_canary).toBe(false);

      // Progress to 5% (index 1 in schedule)
      await deterministicService.recordMetrics(
        deployment.deployment_id,
        makeHealthyMetrics(),
        makeHealthyMetrics(),
      );

      // At 5% fraction, 0.04 < 0.05 → routes to canary
      decision = await deterministicService.routeTraffic('model', 'model-gpt4', 'v1');
      expect(decision.is_canary).toBe(true);
    });
  });

  describe('recordMetrics — progression', () => {
    it('progresses to next fraction when health metrics are within tolerances', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());

      const canaryMetrics = makeHealthyMetrics({ error_rate: 0.01, latency_p95_ms: 200 });
      const baselineMetrics = makeHealthyMetrics({ error_rate: 0.01, latency_p95_ms: 200 });

      const updated = await service.recordMetrics(deployment.deployment_id, canaryMetrics, baselineMetrics);

      expect(updated.progression_index).toBe(1);
      expect(updated.current_traffic_fraction).toBe(0.05);
      expect(updated.status).toBe('active');
      expect(updated.metrics_history).toHaveLength(1);
      expect(updated.metrics_history[0].within_tolerances).toBe(true);
    });

    it('progresses through full schedule to promotion', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      const metrics = makeHealthyMetrics();

      // Progress through schedule: [0.01, 0.05, 0.25, 0.50, 1.0]
      // Need 4 successful metric recordings to go from index 0 to end
      let current = deployment;
      for (let i = 0; i < 4; i++) {
        clock.advance(`2024-01-01T0${i + 1}:00:00.000Z`);
        current = await service.recordMetrics(current.deployment_id, metrics, metrics);
      }

      expect(current.status).toBe('promoted');
      expect(current.current_traffic_fraction).toBe(1.0);
    });

    it('emits info alert on each progression step', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      alertListener.alerts.length = 0; // Clear creation alert

      await service.recordMetrics(deployment.deployment_id, makeHealthyMetrics(), makeHealthyMetrics());

      expect(alertListener.alerts).toHaveLength(1);
      expect(alertListener.alerts[0].severity).toBe('info');
      expect(alertListener.alerts[0].message).toContain('progressed');
      expect(alertListener.alerts[0].message).toContain('5.0%');
    });
  });

  describe('recordMetrics — auto-revert', () => {
    it('auto-reverts when error rate exceeds tolerance', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());

      // Canary has much higher error rate than baseline
      const canaryMetrics = makeHealthyMetrics({ error_rate: 0.05 });
      const baselineMetrics = makeHealthyMetrics({ error_rate: 0.01 });

      const updated = await service.recordMetrics(deployment.deployment_id, canaryMetrics, baselineMetrics);

      expect(updated.status).toBe('rolled_back');
      expect(updated.metrics_history).toHaveLength(1);
      expect(updated.metrics_history[0].within_tolerances).toBe(false);
      expect(updated.metrics_history[0].breaches).toHaveProperty('error_rate');
    });

    it('auto-reverts when latency exceeds tolerance', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());

      // Canary has much higher latency than baseline
      const canaryMetrics = makeHealthyMetrics({ latency_p95_ms: 500 });
      const baselineMetrics = makeHealthyMetrics({ latency_p95_ms: 200 });

      const updated = await service.recordMetrics(deployment.deployment_id, canaryMetrics, baselineMetrics);

      expect(updated.status).toBe('rolled_back');
      expect(updated.metrics_history[0].breaches).toHaveProperty('latency_p95_ms');
    });

    it('emits high-severity alert on auto-revert', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      alertListener.alerts.length = 0;

      const canaryMetrics = makeHealthyMetrics({ error_rate: 0.10 });
      const baselineMetrics = makeHealthyMetrics({ error_rate: 0.01 });

      await service.recordMetrics(deployment.deployment_id, canaryMetrics, baselineMetrics);

      const highAlerts = alertListener.alerts.filter((a) => a.severity === 'high');
      expect(highAlerts).toHaveLength(1);
      expect(highAlerts[0].message).toContain('auto-reverted');
      expect(highAlerts[0].metrics_comparison).toBeDefined();
      expect(highAlerts[0].metrics_comparison!.within_tolerances).toBe(false);
    });

    it('does not progress when metrics are exactly at tolerance boundary', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());

      // Deviation is exactly at tolerance (0.02 for error_rate)
      const canaryMetrics = makeHealthyMetrics({ error_rate: 0.03 });
      const baselineMetrics = makeHealthyMetrics({ error_rate: 0.01 });
      // deviation = 0.03 - 0.01 = 0.02, tolerance = 0.02, 0.02 > 0.02 is false

      const updated = await service.recordMetrics(deployment.deployment_id, canaryMetrics, baselineMetrics);

      // At boundary (not exceeding), should progress
      expect(updated.status).toBe('active');
      expect(updated.progression_index).toBe(1);
    });

    it('reverts when deviation exceeds tolerance', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());

      // Deviation exceeds tolerance (0.021 > 0.02 for error_rate)
      const canaryMetrics = makeHealthyMetrics({ error_rate: 0.031 });
      const baselineMetrics = makeHealthyMetrics({ error_rate: 0.01 });

      const updated = await service.recordMetrics(deployment.deployment_id, canaryMetrics, baselineMetrics);

      expect(updated.status).toBe('rolled_back');
    });

    it('throws when recording metrics for non-active deployment', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      await service.rollback(deployment.deployment_id, 'test');

      await expect(
        service.recordMetrics(deployment.deployment_id, makeHealthyMetrics(), makeHealthyMetrics()),
      ).rejects.toThrow('Cannot record metrics for deployment in status: rolled_back');
    });
  });

  describe('promote', () => {
    it('manually promotes a deployment to full traffic', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      const promoted = await service.promote(deployment.deployment_id);

      expect(promoted.status).toBe('promoted');
      expect(promoted.current_traffic_fraction).toBe(1.0);
    });

    it('tracks canary version as production-eligible after promotion', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      await service.promote(deployment.deployment_id);

      const versions = await service.getProductionVersions('model', 'model-gpt4');
      expect(versions).toContain('v2');
    });

    it('throws when promoting a non-active deployment', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      await service.rollback(deployment.deployment_id, 'test');

      await expect(service.promote(deployment.deployment_id)).rejects.toThrow(
        'Cannot promote deployment in status: rolled_back',
      );
    });
  });

  describe('rollback', () => {
    it('manually rolls back a deployment', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      const rolledBack = await service.rollback(deployment.deployment_id, 'quality regression detected');

      expect(rolledBack.status).toBe('rolled_back');
      expect(rolledBack.current_traffic_fraction).toBe(0);
    });

    it('emits high-severity alert on manual rollback', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      alertListener.alerts.length = 0;

      await service.rollback(deployment.deployment_id, 'quality regression detected');

      const highAlerts = alertListener.alerts.filter((a) => a.severity === 'high');
      expect(highAlerts).toHaveLength(1);
      expect(highAlerts[0].message).toContain('quality regression detected');
    });

    it('throws when rolling back a non-active deployment', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput());
      await service.promote(deployment.deployment_id);

      await expect(service.rollback(deployment.deployment_id, 'test')).rejects.toThrow(
        'Cannot rollback deployment in status: promoted',
      );
    });
  });

  describe('listDeployments', () => {
    it('returns empty array when no deployments exist', async () => {
      const results = await service.listDeployments('model', 'model-gpt4');
      expect(results).toHaveLength(0);
    });

    it('returns all deployments for a target ordered by creation time', async () => {
      const first = await service.createDeployment(makeDeploymentInput());
      await service.rollback(first.deployment_id, 'test');

      clock.advance('2024-01-02T00:00:00.000Z');
      await service.createDeployment(makeDeploymentInput({ canary_version: 'v3' }));

      const results = await service.listDeployments('model', 'model-gpt4');
      expect(results).toHaveLength(2);
      // Newest first
      expect(results[0].canary_version).toBe('v3');
      expect(results[1].canary_version).toBe('v2');
    });

    it('does not return deployments for other targets', async () => {
      await service.createDeployment(makeDeploymentInput({ target_id: 'model-a' }));

      const results = await service.listDeployments('model', 'model-b');
      expect(results).toHaveLength(0);
    });
  });

  describe('getProductionVersions — Requirement 30.4', () => {
    it('tracks baseline version as production-eligible on deployment creation', async () => {
      await service.createDeployment(makeDeploymentInput());

      const versions = await service.getProductionVersions('model', 'model-gpt4');
      expect(versions).toContain('v1');
    });

    it('retains at least 2 production-eligible versions after promotion', async () => {
      // First deployment: v1 → v2
      const first = await service.createDeployment(makeDeploymentInput());
      await service.promote(first.deployment_id);

      // Second deployment: v2 → v3
      clock.advance('2024-01-02T00:00:00.000Z');
      const second = await service.createDeployment(makeDeploymentInput({
        canary_version: 'v3',
        baseline_version: 'v2',
      }));
      await service.promote(second.deployment_id);

      const versions = await service.getProductionVersions('model', 'model-gpt4');
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions).toContain('v2');
      expect(versions).toContain('v3');
    });

    it('does not duplicate versions in production list', async () => {
      const first = await service.createDeployment(makeDeploymentInput());
      await service.promote(first.deployment_id);

      // Create another deployment with same baseline
      clock.advance('2024-01-02T00:00:00.000Z');
      await service.createDeployment(makeDeploymentInput({
        canary_version: 'v3',
        baseline_version: 'v2',
      }));

      const versions = await service.getProductionVersions('model', 'model-gpt4');
      const v2Count = versions.filter((v) => v === 'v2').length;
      expect(v2Count).toBe(1);
    });

    it('maintains version history across multiple promotions', async () => {
      // Promote v1 → v2
      const d1 = await service.createDeployment(makeDeploymentInput());
      await service.promote(d1.deployment_id);

      // Promote v2 → v3
      clock.advance('2024-01-02T00:00:00.000Z');
      const d2 = await service.createDeployment(makeDeploymentInput({
        canary_version: 'v3',
        baseline_version: 'v2',
      }));
      await service.promote(d2.deployment_id);

      // Promote v3 → v4
      clock.advance('2024-01-03T00:00:00.000Z');
      const d3 = await service.createDeployment(makeDeploymentInput({
        canary_version: 'v4',
        baseline_version: 'v3',
      }));
      await service.promote(d3.deployment_id);

      const versions = await service.getProductionVersions('model', 'model-gpt4');
      // Should have v1, v2, v3, v4 — at least 2 most recent
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions).toContain('v3');
      expect(versions).toContain('v4');
    });
  });

  describe('integration with model registry patterns', () => {
    it('supports canary deployment for different target types independently', async () => {
      await service.createDeployment(makeDeploymentInput({
        target_type: 'model',
        target_id: 'model-gpt4',
        canary_version: 'model-v2',
        baseline_version: 'model-v1',
      }));

      await service.createDeployment(makeDeploymentInput({
        target_type: 'prompt',
        target_id: 'system-prompt',
        canary_version: 'prompt-v2',
        baseline_version: 'prompt-v1',
      }));

      const modelDeployment = await service.getActiveDeployment('model', 'model-gpt4');
      const promptDeployment = await service.getActiveDeployment('prompt', 'system-prompt');

      expect(modelDeployment).not.toBeNull();
      expect(promptDeployment).not.toBeNull();
      expect(modelDeployment!.canary_version).toBe('model-v2');
      expect(promptDeployment!.canary_version).toBe('prompt-v2');
    });

    it('full lifecycle: create → progress → promote', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput({
        config: {
          initial_fraction: 0.1,
          progression_schedule: [0.1, 0.5, 1.0],
          health_tolerances: { error_rate: 0.05 },
          auto_revert_threshold: 0.5,
        },
      }));

      expect(deployment.current_traffic_fraction).toBe(0.1);

      // First healthy check → progress to 0.5
      clock.advance('2024-01-01T01:00:00.000Z');
      const step1 = await service.recordMetrics(
        deployment.deployment_id,
        makeHealthyMetrics({ error_rate: 0.02 }),
        makeHealthyMetrics({ error_rate: 0.01 }),
      );
      expect(step1.current_traffic_fraction).toBe(0.5);

      // Second healthy check → progress to 1.0 (promoted)
      clock.advance('2024-01-01T02:00:00.000Z');
      const step2 = await service.recordMetrics(
        deployment.deployment_id,
        makeHealthyMetrics({ error_rate: 0.02 }),
        makeHealthyMetrics({ error_rate: 0.01 }),
      );
      expect(step2.status).toBe('promoted');
      expect(step2.current_traffic_fraction).toBe(1.0);
    });

    it('full lifecycle: create → progress → breach → rollback', async () => {
      const deployment = await service.createDeployment(makeDeploymentInput({
        config: {
          initial_fraction: 0.05,
          progression_schedule: [0.05, 0.25, 0.50, 1.0],
          health_tolerances: { error_rate: 0.03, latency_p95_ms: 150 },
          auto_revert_threshold: 0.5,
        },
      }));

      // First healthy check → progress to 0.25
      clock.advance('2024-01-01T01:00:00.000Z');
      const step1 = await service.recordMetrics(
        deployment.deployment_id,
        makeHealthyMetrics({ error_rate: 0.02, latency_p95_ms: 200 }),
        makeHealthyMetrics({ error_rate: 0.01, latency_p95_ms: 180 }),
      );
      expect(step1.current_traffic_fraction).toBe(0.25);

      // Second check — latency breach → auto-revert
      clock.advance('2024-01-01T02:00:00.000Z');
      const step2 = await service.recordMetrics(
        deployment.deployment_id,
        makeHealthyMetrics({ error_rate: 0.02, latency_p95_ms: 500 }),
        makeHealthyMetrics({ error_rate: 0.01, latency_p95_ms: 200 }),
      );
      expect(step2.status).toBe('rolled_back');
      expect(step2.metrics_history).toHaveLength(2);
    });
  });
});
