/**
 * Compute fabric data models for the Compute_Fabric_Service.
 *
 * The Compute_Fabric_Service distributes compute across available local resources
 * including GPU scheduling, model loading/unloading, inference queue management
 * with priority ordering, and fallback routing.
 *
 * @module compute-fabric
 */

/**
 * Priority level for inference requests.
 */
export type InferencePriority = 'interactive' | 'background';

/**
 * Status of an inference ticket in the queue.
 */
export type InferenceTicketStatus = 'queued' | 'running' | 'completed' | 'failed' | 'fallback';

/**
 * An inventory of available compute resources including GPUs, RAM, and loaded models.
 */
export interface ResourceInventory {
  /** Number of available CPU cores */
  readonly cpu_cores: number;
  /** List of available GPU devices */
  readonly gpu_devices: GPUDevice[];
  /** Total system RAM in megabytes */
  readonly total_ram_mb: number;
  /** Currently available RAM in megabytes */
  readonly available_ram_mb: number;
  /** Models currently loaded into memory/VRAM */
  readonly loaded_models: LoadedModel[];
}

/**
 * A GPU device available for compute workloads.
 */
export interface GPUDevice {
  /** Unique identifier for this device */
  readonly device_id: string;
  /** Human-readable device name */
  readonly name: string;
  /** Total VRAM in megabytes */
  readonly vram_total_mb: number;
  /** Available VRAM in megabytes */
  readonly vram_available_mb: number;
  /** Current utilization as a percentage [0, 100] */
  readonly utilization_percent: number;
}

/**
 * A model currently loaded into memory or VRAM on a specific device.
 */
export interface LoadedModel {
  /** Identifier of the loaded model */
  readonly model_id: string;
  /** Device the model is loaded on */
  readonly device_id: string;
  /** VRAM consumed by this model in megabytes */
  readonly vram_consumed_mb: number;
  /** ISO 8601 timestamp of last inference using this model */
  readonly last_used: string;
  /** Time taken to load the model in milliseconds */
  readonly load_time_ms: number;
}

/**
 * A ticket representing a queued or in-progress inference request.
 */
export interface InferenceTicket {
  /** Unique identifier for this ticket */
  readonly ticket_id: string;
  /** The original request identifier */
  readonly request_id: string;
  /** Priority level of this inference request */
  readonly priority: InferencePriority;
  /** Target device for execution */
  readonly target_device: string;
  /** Model to use for inference */
  readonly model_id: string;
  /** Current position in the queue (0 = next to execute) */
  readonly queue_position: number;
  /** Estimated wait time in milliseconds */
  readonly estimated_wait_ms: number;
  /** Current status of this ticket */
  readonly status: InferenceTicketStatus;
}
