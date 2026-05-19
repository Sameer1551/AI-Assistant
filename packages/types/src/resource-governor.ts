/**
 * Resource governor data models for the Resource_Governor_Service.
 *
 * The Resource_Governor_Service monitors system resources (CPU, RAM, GPU, battery)
 * and enforces adaptive Throttle_Levels across all Platform components with
 * hysteresis to prevent oscillation.
 *
 * @module resource-governor
 */

/**
 * System-wide resource governance level that determines which Platform capabilities are active.
 * - NORMAL: All capabilities active
 * - REDUCED: Non-essential background tasks paused
 * - MINIMAL: Only critical operations permitted
 * - EMERGENCY: Minimum viable operation to prevent system instability
 */
export type ThrottleLevel = 'NORMAL' | 'REDUCED' | 'MINIMAL' | 'EMERGENCY';

/**
 * Current resource utilization status of the system.
 */
export interface ResourceStatus {
  /** ISO 8601 timestamp of this measurement */
  readonly timestamp: string;
  /** CPU usage as a percentage [0, 100] */
  readonly cpu_usage_percent: number;
  /** RAM usage as a percentage [0, 100] */
  readonly ram_usage_percent: number;
  /** GPU usage as a percentage [0, 100], absent if no GPU */
  readonly gpu_usage_percent?: number;
  /** Battery level [0.0, 1.0], null if no battery present */
  readonly battery_level?: number;
  /** Current power source */
  readonly power_state: 'ac' | 'battery' | 'unknown';
  /** Current thermal condition of the system */
  readonly thermal_state: 'nominal' | 'warm' | 'hot' | 'critical';
  /** Current throttle level in effect */
  readonly current_throttle_level: ThrottleLevel;
}

/**
 * A record of a throttle level transition, capturing what triggered the change.
 */
export interface ThrottleLevelTransition {
  /** Unique identifier for this transition */
  readonly transition_id: string;
  /** Throttle level before the transition */
  readonly previous_level: ThrottleLevel;
  /** Throttle level after the transition */
  readonly new_level: ThrottleLevel;
  /** The metric that triggered the transition (e.g., "cpu_usage_percent") */
  readonly triggering_metric: string;
  /** The value of the triggering metric at transition time */
  readonly triggering_value: number;
  /** The threshold that was crossed */
  readonly threshold: number;
  /** ISO 8601 timestamp of the transition */
  readonly timestamp: string;
}

/**
 * Configuration for throttle level thresholds and hysteresis behavior.
 */
export interface ThrottleConfig {
  /** CPU usage thresholds for each throttle level (percentages) */
  readonly cpu_thresholds: ThrottleThresholds;
  /** RAM usage thresholds for each throttle level (percentages) */
  readonly ram_thresholds: ThrottleThresholds;
  /** Hysteresis margin — must drop this much below threshold to resume (default 5%) */
  readonly hysteresis_margin: number;
  /** Maximum CPU percentage the platform is allowed to consume (default 25%) */
  readonly max_platform_cpu_percent: number;
}

/**
 * Threshold values for transitioning between throttle levels.
 */
export interface ThrottleThresholds {
  /** Threshold to enter REDUCED level (default: CPU 60%, RAM 70%) */
  readonly reduced: number;
  /** Threshold to enter MINIMAL level (default: CPU 75%, RAM 80%) */
  readonly minimal: number;
  /** Threshold to enter EMERGENCY level (default: CPU 85%, RAM 88%) */
  readonly emergency: number;
}
