/**
 * Canary Deployment interfaces for progressive traffic shifting.
 *
 * Defines contracts for canary deployment management including:
 * - Deployment lifecycle (create, promote, rollback)
 * - Traffic splitting decisions
 * - Health metrics collection and evaluation
 * - Automatic promotion/rollback based on success criteria
 *
 * @see Requirement 30.1 — initial canary fraction routing
 * @see Requirement 30.2 — progression when health metrics within tolerances
 * @see Requirement 30.3 — auto-revert on health metric breach
 * @see Requirement 30.4 — retain at least 2 production-eligible versions
 */

import type { CanaryConfig } from '@may/types';

/**
 * Status of a canary deployment.
 */
export type CanaryDeploymentStatus =
  | 'pending'      // Created but not yet receiving traffic
  | 'active'       // Currently receiving canary traffic
  | 'promoting'    // In the process of being promoted to full traffic
  | 'promoted'     // Successfully promoted to 100% traffic
  | 'rolling_back' // In the process of being rolled back
  | 'rolled_back'  // Rolled back due to health metric breach
  | 'cancelled';   // Manually cancelled

/**
 * Type of deployment target.
 */
export type CanaryTargetType = 'model' | 'prompt';

/**
 * Health metrics snapshot for a canary deployment.
 */
export interface CanaryHealthMetrics {
  /** Error rate as a fraction (0.0 - 1.0). */
  readonly error_rate: number;
  /** P95 latency in milliseconds. */
  readonly latency_p95_ms: number;
  /** Average quality score (0.0 - 1.0), if available. */
  readonly quality_score?: number;
  /** Total number of requests processed. */
  readonly request_count: number;
  /** Timestamp of this metrics snapshot (ISO 8601). */
  readonly collected_at: string;
}

/**
 * Comparison of canary vs baseline metrics.
 */
export interface CanaryMetricsComparison {
  /** Metrics for the canary (new) version. */
  readonly canary: CanaryHealthMetrics;
  /** Metrics for the baseline (current) version. */
  readonly baseline: CanaryHealthMetrics;
  /** Whether all health tolerances are satisfied. */
  readonly within_tolerances: boolean;
  /** Per-metric breach details (metric name → actual deviation). */
  readonly breaches: Readonly<Record<string, number>>;
}

/**
 * Alert severity levels for canary events.
 */
export type AlertSeverity = 'info' | 'warning' | 'high' | 'critical';

/**
 * Alert emitted during canary deployment lifecycle.
 */
export interface CanaryAlert {
  /** Unique alert identifier. */
  readonly alert_id: string;
  /** The deployment this alert relates to. */
  readonly deployment_id: string;
  /** Severity of the alert. */
  readonly severity: AlertSeverity;
  /** Human-readable message. */
  readonly message: string;
  /** Metrics comparison that triggered the alert, if applicable. */
  readonly metrics_comparison?: CanaryMetricsComparison;
  /** Timestamp of the alert (ISO 8601). */
  readonly emitted_at: string;
}

/**
 * A canary deployment record tracking the lifecycle of a version rollout.
 */
export interface CanaryDeployment {
  /** Unique deployment identifier. */
  readonly deployment_id: string;
  /** Type of target being deployed (model or prompt). */
  readonly target_type: CanaryTargetType;
  /** Identifier of the target (model_id or prompt_id). */
  readonly target_id: string;
  /** Version being deployed as canary. */
  readonly canary_version: string;
  /** Version currently serving as baseline. */
  readonly baseline_version: string;
  /** Current deployment status. */
  readonly status: CanaryDeploymentStatus;
  /** Current traffic fraction routed to canary (0.0 - 1.0). */
  readonly current_traffic_fraction: number;
  /** Current position in the progression schedule (index). */
  readonly progression_index: number;
  /** Canary configuration governing this deployment. */
  readonly config: CanaryConfig;
  /** History of metrics comparisons. */
  readonly metrics_history: readonly CanaryMetricsComparison[];
  /** Alerts emitted during this deployment. */
  readonly alerts: readonly CanaryAlert[];
  /** Timestamp when the deployment was created (ISO 8601). */
  readonly created_at: string;
  /** Timestamp of the last status change (ISO 8601). */
  readonly updated_at: string;
}

/**
 * Input for creating a new canary deployment.
 */
export interface CreateCanaryDeploymentInput {
  /** Type of target being deployed. */
  readonly target_type: CanaryTargetType;
  /** Identifier of the target (model_id or prompt_id). */
  readonly target_id: string;
  /** Version being deployed as canary. */
  readonly canary_version: string;
  /** Version currently serving as baseline. */
  readonly baseline_version: string;
  /** Canary configuration to use. */
  readonly config: CanaryConfig;
}

/**
 * Result of a traffic routing decision.
 */
export interface TrafficRoutingDecision {
  /** Which version to route this request to. */
  readonly routed_version: string;
  /** Whether this request was routed to the canary. */
  readonly is_canary: boolean;
  /** The deployment that influenced this decision, if any. */
  readonly deployment_id?: string;
}

/**
 * Interface for the canary deployment service.
 *
 * Manages the lifecycle of canary deployments including creation,
 * traffic splitting, health evaluation, and automatic promotion/rollback.
 */
export interface ICanaryDeploymentService {
  /**
   * Create a new canary deployment.
   * Starts routing the initial canary fraction to the new version.
   *
   * @param input - Deployment configuration
   * @returns The created deployment
   */
  createDeployment(input: CreateCanaryDeploymentInput): Promise<CanaryDeployment>;

  /**
   * Get a deployment by its ID.
   *
   * @param deploymentId - The deployment identifier
   * @returns The deployment if found, null otherwise
   */
  getDeployment(deploymentId: string): Promise<CanaryDeployment | null>;

  /**
   * Get the active deployment for a target, if any.
   *
   * @param targetType - Type of target
   * @param targetId - Target identifier
   * @returns The active deployment if one exists, null otherwise
   */
  getActiveDeployment(targetType: CanaryTargetType, targetId: string): Promise<CanaryDeployment | null>;

  /**
   * Make a traffic routing decision for a request.
   * Uses the active canary deployment (if any) to determine which version to route to.
   *
   * @param targetType - Type of target
   * @param targetId - Target identifier
   * @param baselineVersion - The current baseline version
   * @returns Routing decision indicating which version to use
   */
  routeTraffic(targetType: CanaryTargetType, targetId: string, baselineVersion: string): Promise<TrafficRoutingDecision>;

  /**
   * Record health metrics for a canary deployment.
   * Evaluates whether the deployment should progress, hold, or rollback.
   *
   * @param deploymentId - The deployment identifier
   * @param canaryMetrics - Metrics from canary traffic
   * @param baselineMetrics - Metrics from baseline traffic
   * @returns Updated deployment after evaluation
   */
  recordMetrics(
    deploymentId: string,
    canaryMetrics: CanaryHealthMetrics,
    baselineMetrics: CanaryHealthMetrics,
  ): Promise<CanaryDeployment>;

  /**
   * Manually promote a canary deployment to full traffic.
   *
   * @param deploymentId - The deployment identifier
   * @returns Updated deployment
   */
  promote(deploymentId: string): Promise<CanaryDeployment>;

  /**
   * Manually rollback a canary deployment.
   *
   * @param deploymentId - The deployment identifier
   * @param reason - Reason for the rollback
   * @returns Updated deployment
   */
  rollback(deploymentId: string, reason: string): Promise<CanaryDeployment>;

  /**
   * List all deployments for a target.
   *
   * @param targetType - Type of target
   * @param targetId - Target identifier
   * @returns All deployments for the target, ordered by creation time (newest first)
   */
  listDeployments(targetType: CanaryTargetType, targetId: string): Promise<readonly CanaryDeployment[]>;

  /**
   * Get the production-eligible versions for a target.
   * Returns at least the 2 most recent production-eligible versions.
   *
   * @param targetType - Type of target
   * @param targetId - Target identifier
   * @returns Ordered list of production-eligible versions (newest first)
   * @see Requirement 30.4 — retain at least 2 production-eligible versions
   */
  getProductionVersions(targetType: CanaryTargetType, targetId: string): Promise<readonly string[]>;
}
