/**
 * Canary Deployment Service implementation.
 *
 * Manages progressive traffic shifting for model and prompt version rollouts.
 * Routes an initial canary fraction of traffic to new versions, progressively
 * increases traffic share when health metrics remain within tolerances, and
 * automatically reverts on health metric breach with high-severity alert.
 *
 * Retains at least 2 production-eligible versions for immediate rollback.
 *
 * @see Requirement 30.1 — initial canary fraction routing
 * @see Requirement 30.2 — progression when health metrics within tolerances
 * @see Requirement 30.3 — auto-revert on health metric breach
 * @see Requirement 30.4 — retain at least 2 production-eligible versions
 */

import type { CanaryConfig } from '@may/types';
import type {
  ICanaryDeploymentService,
  CanaryDeployment,
  CanaryTargetType,
  CanaryHealthMetrics,
  CanaryMetricsComparison,
  CanaryAlert,
  AlertSeverity,
  CreateCanaryDeploymentInput,
  TrafficRoutingDecision,
  IClock,
  IIdGenerator,
} from './interfaces/index.js';

/**
 * Listener interface for canary deployment alerts.
 * Consumers can subscribe to receive alerts emitted during deployment lifecycle.
 */
export interface ICanaryAlertListener {
  onAlert(alert: CanaryAlert): void;
}

/**
 * In-memory implementation of the Canary Deployment Service.
 *
 * Stores deployment state in memory. For production use, this would be
 * backed by durable storage to survive restarts.
 */
export class CanaryDeploymentService implements ICanaryDeploymentService {
  private readonly deployments = new Map<string, CanaryDeployment>();
  private readonly productionVersions = new Map<string, string[]>(); // key: "type:id"
  private readonly alertListeners: ICanaryAlertListener[] = [];
  private readonly randomFn: () => number;

  constructor(
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
    randomFn?: () => number,
  ) {
    this.randomFn = randomFn ?? Math.random;
  }

  /**
   * Register an alert listener to receive canary deployment alerts.
   */
  addAlertListener(listener: ICanaryAlertListener): void {
    this.alertListeners.push(listener);
  }

  async createDeployment(input: CreateCanaryDeploymentInput): Promise<CanaryDeployment> {
    const targetKey = this.targetKey(input.target_type, input.target_id);

    // Check for existing active deployment on this target
    const existing = await this.getActiveDeployment(input.target_type, input.target_id);
    if (existing) {
      throw new Error(
        `Active canary deployment already exists for ${input.target_type}:${input.target_id} (deployment: ${existing.deployment_id})`,
      );
    }

    const now = this.clock.nowISO();
    const deploymentId = this.idGenerator.version();
    const initialFraction = input.config.initial_fraction;

    const deployment: CanaryDeployment = {
      deployment_id: deploymentId,
      target_type: input.target_type,
      target_id: input.target_id,
      canary_version: input.canary_version,
      baseline_version: input.baseline_version,
      status: 'active',
      current_traffic_fraction: initialFraction,
      progression_index: 0,
      config: input.config,
      metrics_history: [],
      alerts: [],
      created_at: now,
      updated_at: now,
    };

    this.deployments.set(deploymentId, deployment);

    // Ensure baseline version is tracked as production-eligible
    this.ensureProductionVersion(targetKey, input.baseline_version);

    // Emit info alert about deployment start
    this.emitAlert(deployment, 'info', `Canary deployment started: routing ${(initialFraction * 100).toFixed(1)}% traffic to version ${input.canary_version}`);

    return this.deployments.get(deploymentId)!;
  }

  async getDeployment(deploymentId: string): Promise<CanaryDeployment | null> {
    return this.deployments.get(deploymentId) ?? null;
  }

  async getActiveDeployment(targetType: CanaryTargetType, targetId: string): Promise<CanaryDeployment | null> {
    for (const deployment of this.deployments.values()) {
      if (
        deployment.target_type === targetType &&
        deployment.target_id === targetId &&
        (deployment.status === 'active' || deployment.status === 'promoting')
      ) {
        return deployment;
      }
    }
    return null;
  }

  async routeTraffic(
    targetType: CanaryTargetType,
    targetId: string,
    baselineVersion: string,
  ): Promise<TrafficRoutingDecision> {
    const activeDeployment = await this.getActiveDeployment(targetType, targetId);

    if (!activeDeployment) {
      return {
        routed_version: baselineVersion,
        is_canary: false,
      };
    }

    // Use random number to decide traffic split
    const random = this.randomFn();
    const isCanary = random < activeDeployment.current_traffic_fraction;

    return {
      routed_version: isCanary ? activeDeployment.canary_version : activeDeployment.baseline_version,
      is_canary: isCanary,
      deployment_id: activeDeployment.deployment_id,
    };
  }

  async recordMetrics(
    deploymentId: string,
    canaryMetrics: CanaryHealthMetrics,
    baselineMetrics: CanaryHealthMetrics,
  ): Promise<CanaryDeployment> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) {
      throw new Error(`Canary deployment not found: ${deploymentId}`);
    }

    if (deployment.status !== 'active') {
      throw new Error(`Cannot record metrics for deployment in status: ${deployment.status}`);
    }

    // Evaluate health metrics against tolerances
    const comparison = this.evaluateMetrics(canaryMetrics, baselineMetrics, deployment.config);

    // Add comparison to history
    const updatedMetricsHistory = [...deployment.metrics_history, comparison];

    if (!comparison.within_tolerances) {
      // Health metrics breached — auto-revert
      const rolledBack = this.updateDeployment(deployment, {
        status: 'rolled_back',
        metrics_history: updatedMetricsHistory,
      });

      // Emit high-severity alert per Requirement 30.3
      this.emitAlert(
        rolledBack,
        'high',
        `Canary deployment auto-reverted: health metrics breached tolerances. Breaches: ${JSON.stringify(comparison.breaches)}`,
        comparison,
      );

      return this.deployments.get(deploymentId)!;
    }

    // Health metrics within tolerances — check if we should progress
    const nextIndex = deployment.progression_index + 1;
    const schedule = deployment.config.progression_schedule;

    if (nextIndex >= schedule.length) {
      // Already at the last step — promote to full traffic
      const promoted = this.updateDeployment(deployment, {
        status: 'promoted',
        current_traffic_fraction: 1.0,
        progression_index: deployment.progression_index,
        metrics_history: updatedMetricsHistory,
      });

      // Track canary version as production-eligible
      const targetKey = this.targetKey(deployment.target_type, deployment.target_id);
      this.ensureProductionVersion(targetKey, deployment.canary_version);

      this.emitAlert(promoted, 'info', `Canary deployment promoted: version ${deployment.canary_version} now serving 100% traffic`);

      return this.deployments.get(deploymentId)!;
    }

    // Progress to next fraction in schedule
    const nextFraction = schedule[nextIndex];

    // If the next fraction is 1.0 (full traffic), this is a promotion
    if (nextFraction !== undefined && nextFraction >= 1.0) {
      const promoted = this.updateDeployment(deployment, {
        status: 'promoted',
        current_traffic_fraction: 1.0,
        progression_index: nextIndex,
        metrics_history: updatedMetricsHistory,
      });

      // Track canary version as production-eligible
      const targetKey = this.targetKey(deployment.target_type, deployment.target_id);
      this.ensureProductionVersion(targetKey, deployment.canary_version);

      this.emitAlert(promoted, 'info', `Canary deployment promoted: version ${deployment.canary_version} now serving 100% traffic`);

      return this.deployments.get(deploymentId)!;
    }

    const progressed = this.updateDeployment(deployment, {
      current_traffic_fraction: nextFraction!,
      progression_index: nextIndex,
      metrics_history: updatedMetricsHistory,
    });

    this.emitAlert(
      progressed,
      'info',
      `Canary deployment progressed: now routing ${((nextFraction ?? 0) * 100).toFixed(1)}% traffic to version ${deployment.canary_version}`,
    );

    return this.deployments.get(deploymentId)!;
  }

  async promote(deploymentId: string): Promise<CanaryDeployment> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) {
      throw new Error(`Canary deployment not found: ${deploymentId}`);
    }

    if (deployment.status !== 'active') {
      throw new Error(`Cannot promote deployment in status: ${deployment.status}`);
    }

    const promoted = this.updateDeployment(deployment, {
      status: 'promoted',
      current_traffic_fraction: 1.0,
    });

    // Track canary version as production-eligible
    const targetKey = this.targetKey(deployment.target_type, deployment.target_id);
    this.ensureProductionVersion(targetKey, deployment.canary_version);

    this.emitAlert(promoted, 'info', `Canary deployment manually promoted: version ${deployment.canary_version} now serving 100% traffic`);

    return this.deployments.get(deploymentId)!;
  }

  async rollback(deploymentId: string, reason: string): Promise<CanaryDeployment> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) {
      throw new Error(`Canary deployment not found: ${deploymentId}`);
    }

    if (deployment.status !== 'active' && deployment.status !== 'promoting') {
      throw new Error(`Cannot rollback deployment in status: ${deployment.status}`);
    }

    const rolledBack = this.updateDeployment(deployment, {
      status: 'rolled_back',
      current_traffic_fraction: 0,
    });

    this.emitAlert(rolledBack, 'high', `Canary deployment rolled back: ${reason}`);

    return this.deployments.get(deploymentId)!;
  }

  async listDeployments(targetType: CanaryTargetType, targetId: string): Promise<readonly CanaryDeployment[]> {
    const results: CanaryDeployment[] = [];
    for (const deployment of this.deployments.values()) {
      if (deployment.target_type === targetType && deployment.target_id === targetId) {
        results.push(deployment);
      }
    }
    // Sort by creation time, newest first
    results.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return results;
  }

  async getProductionVersions(targetType: CanaryTargetType, targetId: string): Promise<readonly string[]> {
    const targetKey = this.targetKey(targetType, targetId);
    const versions = this.productionVersions.get(targetKey) ?? [];
    // Return at least 2 most recent (already ordered newest first)
    return versions;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Evaluate canary metrics against baseline using configured tolerances.
   */
  private evaluateMetrics(
    canaryMetrics: CanaryHealthMetrics,
    baselineMetrics: CanaryHealthMetrics,
    config: CanaryConfig,
  ): CanaryMetricsComparison {
    const breaches: Record<string, number> = {};

    for (const [metricName, tolerance] of Object.entries(config.health_tolerances)) {
      const canaryValue = this.getMetricValue(canaryMetrics, metricName);
      const baselineValue = this.getMetricValue(baselineMetrics, metricName);

      if (canaryValue === undefined || baselineValue === undefined) {
        continue;
      }

      // Calculate deviation: how much worse the canary is compared to baseline
      const deviation = canaryValue - baselineValue;

      if (deviation > tolerance) {
        breaches[metricName] = deviation;
      }
    }

    return {
      canary: canaryMetrics,
      baseline: baselineMetrics,
      within_tolerances: Object.keys(breaches).length === 0,
      breaches,
    };
  }

  /**
   * Extract a named metric value from a CanaryHealthMetrics object.
   */
  private getMetricValue(metrics: CanaryHealthMetrics, metricName: string): number | undefined {
    switch (metricName) {
      case 'error_rate':
        return metrics.error_rate;
      case 'latency_p95_ms':
        return metrics.latency_p95_ms;
      case 'quality_score':
        // For quality score, lower is worse, so we invert the comparison
        // by returning negative (higher quality_score = better)
        return metrics.quality_score !== undefined ? -metrics.quality_score : undefined;
      default:
        return undefined;
    }
  }

  /**
   * Update a deployment record immutably.
   */
  private updateDeployment(
    deployment: CanaryDeployment,
    updates: Partial<Pick<CanaryDeployment, 'status' | 'current_traffic_fraction' | 'progression_index' | 'metrics_history' | 'alerts'>>,
  ): CanaryDeployment {
    const now = this.clock.nowISO();
    const updated: CanaryDeployment = {
      ...deployment,
      ...updates,
      updated_at: now,
    };
    this.deployments.set(deployment.deployment_id, updated);
    return updated;
  }

  /**
   * Emit an alert and add it to the deployment's alert history.
   */
  private emitAlert(
    deployment: CanaryDeployment,
    severity: AlertSeverity,
    message: string,
    metricsComparison?: CanaryMetricsComparison,
  ): void {
    const alert: CanaryAlert = {
      alert_id: this.idGenerator.version(),
      deployment_id: deployment.deployment_id,
      severity,
      message,
      metrics_comparison: metricsComparison,
      emitted_at: this.clock.nowISO(),
    };

    // Add alert to deployment history
    const updated: CanaryDeployment = {
      ...deployment,
      alerts: [...deployment.alerts, alert],
    };
    this.deployments.set(deployment.deployment_id, updated);

    // Notify listeners
    for (const listener of this.alertListeners) {
      listener.onAlert(alert);
    }
  }

  /**
   * Ensure a version is tracked as production-eligible for a target.
   * Maintains at least 2 most recent versions per Requirement 30.4.
   */
  private ensureProductionVersion(targetKey: string, version: string): void {
    const versions = this.productionVersions.get(targetKey) ?? [];

    // Don't add duplicates
    if (versions.includes(version)) {
      return;
    }

    // Add to front (newest first)
    const updated = [version, ...versions];
    this.productionVersions.set(targetKey, updated);
  }

  /**
   * Generate a composite key for a target.
   */
  private targetKey(targetType: CanaryTargetType, targetId: string): string {
    return `${targetType}:${targetId}`;
  }
}
