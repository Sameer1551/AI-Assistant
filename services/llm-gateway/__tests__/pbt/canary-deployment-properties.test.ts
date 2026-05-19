/**
 * Property-based tests for canary deployment auto-revert behavior.
 *
 * **Validates: Requirements 30.1, 30.2, 30.3**
 *
 * Property 40: Canary Deployment Progression — For any canary deployment where
 *   recorded metrics show the canary version's error rate or latency exceeding
 *   the configured tolerance compared to baseline, the deployment must
 *   automatically transition to rolled_back status and emit a high-severity alert.
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@may/testing';
import { CanaryDeploymentService } from '../../src/canary-deployment.js';
import type {
  IClock,
  IIdGenerator,
  CreateCanaryDeploymentInput,
  CanaryHealthMetrics,
  CanaryAlert,
} from '../../src/interfaces/index.js';
import type { ICanaryAlertListener } from '../../src/canary-deployment.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private current = '2024-01-01T00:00:00.000Z';

  nowISO(): string {
    return this.current;
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;

  version(): string {
    this.counter++;
    return `pbt-id-${this.counter}`;
  }
}

class AlertCollector implements ICanaryAlertListener {
  readonly alerts: CanaryAlert[] = [];

  onAlert(alert: CanaryAlert): void {
    this.alerts.push(alert);
  }

  get highSeverityAlerts(): CanaryAlert[] {
    return this.alerts.filter((a) => a.severity === 'high' || a.severity === 'critical');
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for canary target type. */
const targetTypeArb = fc.constantFrom('model' as const, 'prompt' as const);

/** Arbitrary for non-empty target IDs. */
const targetIdArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 3, maxLength: 20 },
);

/**
 * Arbitrary for a pair of distinct version strings.
 * Avoids the need for fc.pre() by construction.
 */
const distinctVersionPairArb = fc.integer({ min: 1, max: 999 }).chain((n) =>
  fc.constant({ canaryVersion: `v${n + 1}`, baselineVersion: `v${n}` }),
);

/** Arbitrary for initial canary fraction (0 < fraction < 1). */
const initialFractionArb = fc.double({ min: 0.01, max: 0.5, noNaN: true });

/** Arbitrary for error rate tolerance (positive). */
const errorRateToleranceArb = fc.double({ min: 0.005, max: 0.3, noNaN: true });

/** Arbitrary for latency tolerance in ms (positive). */
const latencyToleranceArb = fc.double({ min: 10, max: 500, noNaN: true });

/** Arbitrary for baseline error rate (0 to 0.3). */
const baselineErrorRateArb = fc.double({ min: 0.0, max: 0.3, noNaN: true });

/** Arbitrary for baseline latency in ms (positive). */
const baselineLatencyArb = fc.double({ min: 50, max: 1000, noNaN: true });

/**
 * Arbitrary for a positive breach amount — the amount by which the canary
 * metric exceeds the tolerance above baseline. Must be strictly positive.
 */
const breachAmountArb = fc.double({ min: 0.001, max: 0.5, noNaN: true });

/** Arbitrary for request count. */
const requestCountArb = fc.integer({ min: 1, max: 10000 });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 40: Canary Deployment Auto-Revert on Health Metric Breach', () => {
  it('auto-reverts to rolled_back status when error rate breaches tolerance', async () => {
    await fc.assert(
      fc.asyncProperty(
        targetTypeArb,
        targetIdArb,
        distinctVersionPairArb,
        initialFractionArb,
        errorRateToleranceArb,
        baselineErrorRateArb,
        breachAmountArb,
        requestCountArb,
        async (
          targetType,
          targetId,
          versions,
          initialFraction,
          errorRateTolerance,
          baselineErrorRate,
          breachAmount,
          requestCount,
        ) => {
          const clock = new MockClock();
          const idGen = new MockIdGenerator();
          const alertCollector = new AlertCollector();
          const service = new CanaryDeploymentService(clock, idGen);
          service.addAlertListener(alertCollector);

          // Canary error rate exceeds baseline + tolerance
          const canaryErrorRate = baselineErrorRate + errorRateTolerance + breachAmount;

          const config = {
            initial_fraction: initialFraction,
            progression_schedule: [initialFraction, 0.25, 0.5, 1.0],
            health_tolerances: { error_rate: errorRateTolerance },
            auto_revert_threshold: 0.5,
          };

          const input: CreateCanaryDeploymentInput = {
            target_type: targetType,
            target_id: targetId,
            canary_version: versions.canaryVersion,
            baseline_version: versions.baselineVersion,
            config,
          };

          const deployment = await service.createDeployment(input);

          const canaryMetrics: CanaryHealthMetrics = {
            error_rate: canaryErrorRate,
            latency_p95_ms: 200,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const baselineMetrics: CanaryHealthMetrics = {
            error_rate: baselineErrorRate,
            latency_p95_ms: 200,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const result = await service.recordMetrics(
            deployment.deployment_id,
            canaryMetrics,
            baselineMetrics,
          );

          // PROPERTY: deployment must transition to rolled_back
          expect(result.status).toBe('rolled_back');

          // PROPERTY: a high-severity alert must be emitted
          expect(alertCollector.highSeverityAlerts.length).toBeGreaterThanOrEqual(1);

          const revertAlert = alertCollector.highSeverityAlerts.find(
            (a) => a.deployment_id === deployment.deployment_id,
          );
          expect(revertAlert).toBeDefined();
          expect(revertAlert!.severity).toBe('high');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('auto-reverts to rolled_back status when latency breaches tolerance', async () => {
    await fc.assert(
      fc.asyncProperty(
        targetTypeArb,
        targetIdArb,
        distinctVersionPairArb,
        initialFractionArb,
        latencyToleranceArb,
        baselineLatencyArb,
        breachAmountArb,
        requestCountArb,
        async (
          targetType,
          targetId,
          versions,
          initialFraction,
          latencyTolerance,
          baselineLatency,
          breachAmount,
          requestCount,
        ) => {
          const clock = new MockClock();
          const idGen = new MockIdGenerator();
          const alertCollector = new AlertCollector();
          const service = new CanaryDeploymentService(clock, idGen);
          service.addAlertListener(alertCollector);

          // Canary latency exceeds baseline + tolerance
          const canaryLatency = baselineLatency + latencyTolerance + breachAmount;

          const config = {
            initial_fraction: initialFraction,
            progression_schedule: [initialFraction, 0.25, 0.5, 1.0],
            health_tolerances: { latency_p95_ms: latencyTolerance },
            auto_revert_threshold: 0.5,
          };

          const input: CreateCanaryDeploymentInput = {
            target_type: targetType,
            target_id: targetId,
            canary_version: versions.canaryVersion,
            baseline_version: versions.baselineVersion,
            config,
          };

          const deployment = await service.createDeployment(input);

          const canaryMetrics: CanaryHealthMetrics = {
            error_rate: 0.01,
            latency_p95_ms: canaryLatency,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const baselineMetrics: CanaryHealthMetrics = {
            error_rate: 0.01,
            latency_p95_ms: baselineLatency,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const result = await service.recordMetrics(
            deployment.deployment_id,
            canaryMetrics,
            baselineMetrics,
          );

          // PROPERTY: deployment must transition to rolled_back
          expect(result.status).toBe('rolled_back');

          // PROPERTY: a high-severity alert must be emitted
          expect(alertCollector.highSeverityAlerts.length).toBeGreaterThanOrEqual(1);

          const revertAlert = alertCollector.highSeverityAlerts.find(
            (a) => a.deployment_id === deployment.deployment_id,
          );
          expect(revertAlert).toBeDefined();
          expect(revertAlert!.severity).toBe('high');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('auto-reverts and emits alert when either error rate OR latency breaches tolerance', async () => {
    await fc.assert(
      fc.asyncProperty(
        targetTypeArb,
        targetIdArb,
        distinctVersionPairArb,
        initialFractionArb,
        errorRateToleranceArb,
        latencyToleranceArb,
        baselineErrorRateArb,
        baselineLatencyArb,
        breachAmountArb,
        fc.boolean(), // which metric breaches: true = error_rate, false = latency
        requestCountArb,
        async (
          targetType,
          targetId,
          versions,
          initialFraction,
          errorRateTolerance,
          latencyTolerance,
          baselineErrorRate,
          baselineLatency,
          breachAmount,
          breachErrorRate,
          requestCount,
        ) => {
          const clock = new MockClock();
          const idGen = new MockIdGenerator();
          const alertCollector = new AlertCollector();
          const service = new CanaryDeploymentService(clock, idGen);
          service.addAlertListener(alertCollector);

          // One metric breaches, the other stays within tolerance
          const canaryErrorRate = breachErrorRate
            ? baselineErrorRate + errorRateTolerance + breachAmount
            : baselineErrorRate; // within tolerance (same as baseline)
          const canaryLatency = breachErrorRate
            ? baselineLatency // within tolerance (same as baseline)
            : baselineLatency + latencyTolerance + breachAmount;

          const config = {
            initial_fraction: initialFraction,
            progression_schedule: [initialFraction, 0.25, 0.5, 1.0],
            health_tolerances: {
              error_rate: errorRateTolerance,
              latency_p95_ms: latencyTolerance,
            },
            auto_revert_threshold: 0.5,
          };

          const input: CreateCanaryDeploymentInput = {
            target_type: targetType,
            target_id: targetId,
            canary_version: versions.canaryVersion,
            baseline_version: versions.baselineVersion,
            config,
          };

          const deployment = await service.createDeployment(input);

          const canaryMetrics: CanaryHealthMetrics = {
            error_rate: canaryErrorRate,
            latency_p95_ms: canaryLatency,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const baselineMetrics: CanaryHealthMetrics = {
            error_rate: baselineErrorRate,
            latency_p95_ms: baselineLatency,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const result = await service.recordMetrics(
            deployment.deployment_id,
            canaryMetrics,
            baselineMetrics,
          );

          // PROPERTY: deployment must transition to rolled_back
          expect(result.status).toBe('rolled_back');

          // PROPERTY: a high-severity alert must be emitted
          expect(alertCollector.highSeverityAlerts.length).toBeGreaterThanOrEqual(1);

          const revertAlert = alertCollector.highSeverityAlerts.find(
            (a) => a.deployment_id === deployment.deployment_id,
          );
          expect(revertAlert).toBeDefined();
          expect(revertAlert!.metrics_comparison).toBeDefined();
          expect(revertAlert!.metrics_comparison!.within_tolerances).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does NOT revert when metrics remain within tolerances (progression occurs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        targetTypeArb,
        targetIdArb,
        distinctVersionPairArb,
        initialFractionArb,
        errorRateToleranceArb,
        latencyToleranceArb,
        baselineErrorRateArb,
        baselineLatencyArb,
        requestCountArb,
        async (
          targetType,
          targetId,
          versions,
          initialFraction,
          errorRateTolerance,
          latencyTolerance,
          baselineErrorRate,
          baselineLatency,
          requestCount,
        ) => {
          const clock = new MockClock();
          const idGen = new MockIdGenerator();
          const alertCollector = new AlertCollector();
          const service = new CanaryDeploymentService(clock, idGen);
          service.addAlertListener(alertCollector);

          // Both metrics stay within tolerance (canary = baseline, deviation = 0)
          const config = {
            initial_fraction: initialFraction,
            progression_schedule: [initialFraction, 0.25, 0.5, 1.0],
            health_tolerances: {
              error_rate: errorRateTolerance,
              latency_p95_ms: latencyTolerance,
            },
            auto_revert_threshold: 0.5,
          };

          const input: CreateCanaryDeploymentInput = {
            target_type: targetType,
            target_id: targetId,
            canary_version: versions.canaryVersion,
            baseline_version: versions.baselineVersion,
            config,
          };

          const deployment = await service.createDeployment(input);

          // Canary metrics identical to baseline — no deviation
          const canaryMetrics: CanaryHealthMetrics = {
            error_rate: baselineErrorRate,
            latency_p95_ms: baselineLatency,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const baselineMetrics: CanaryHealthMetrics = {
            error_rate: baselineErrorRate,
            latency_p95_ms: baselineLatency,
            request_count: requestCount,
            collected_at: '2024-01-01T01:00:00.000Z',
          };

          const result = await service.recordMetrics(
            deployment.deployment_id,
            canaryMetrics,
            baselineMetrics,
          );

          // PROPERTY: deployment must NOT be rolled back
          expect(result.status).not.toBe('rolled_back');

          // PROPERTY: no high-severity alerts emitted (only info alerts for progression)
          const highAlertsForDeployment = alertCollector.highSeverityAlerts.filter(
            (a) => a.deployment_id === deployment.deployment_id,
          );
          expect(highAlertsForDeployment).toHaveLength(0);

          // PROPERTY: progression occurred (index advanced or promoted)
          expect(
            result.progression_index > deployment.progression_index ||
            result.status === 'promoted',
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
