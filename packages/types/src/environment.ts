/**
 * Environment model data types for the Environment_Model_Service.
 *
 * The Environment_Model_Service maintains a live model of the End_User's computing
 * environment including hardware classification, power state, connectivity, thermal
 * state, and monitor configuration. Emits events on significant changes.
 *
 * @module environment
 */

/**
 * Hardware capability tier classification.
 */
export type HardwareTier = 'low' | 'mid' | 'high';

/**
 * Physical environment classification for the user's workspace.
 */
export type PhysicalEnvironment = 'home_office' | 'mobile' | 'unknown';

/**
 * A snapshot of the End_User's computing environment at a point in time.
 */
export interface EnvironmentState {
  /** Unique identifier for this state snapshot */
  readonly state_id: string;
  /** Tenant that owns this environment record */
  readonly tenant_id: string;
  /** Principal whose environment this represents */
  readonly principal_id: string;
  /** ISO 8601 timestamp of this snapshot */
  readonly timestamp: string;
  /** Classification of hardware capability */
  readonly hardware_tier: HardwareTier;
  /** Whether a GPU is available */
  readonly gpu_available: boolean;
  /** GPU VRAM in megabytes, if GPU is available */
  readonly gpu_vram_mb?: number;
  /** Battery level [0.0, 1.0], absent if no battery */
  readonly battery_level?: number;
  /** Current power source */
  readonly power_state: 'ac' | 'battery' | 'unknown';
  /** Current thermal condition */
  readonly thermal_state: 'nominal' | 'warm' | 'hot' | 'critical';
  /** Internet connectivity quality */
  readonly internet_connectivity: 'high_speed' | 'low_speed' | 'offline';
  /** Number of connected monitors */
  readonly monitor_count: number;
  /** Classification of the physical workspace */
  readonly physical_environment: PhysicalEnvironment;
}

/**
 * An event emitted when a significant change occurs in the environment.
 */
export interface EnvironmentChangeEvent {
  /** Unique identifier for this event */
  readonly event_id: string;
  /** Type of change that occurred (e.g., "power_state_change", "connectivity_change") */
  readonly change_type: string;
  /** Previous value of the changed property */
  readonly previous_value: string;
  /** New value of the changed property */
  readonly new_value: string;
  /** ISO 8601 timestamp of when the change was detected */
  readonly timestamp: string;
}
