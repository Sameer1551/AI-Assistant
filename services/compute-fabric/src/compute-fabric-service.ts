/**
 * @module compute-fabric-service
 * Compute_Fabric_Service: GPU resource management, priority queue, and fallbacks.
 *
 * @see Requirements 54.1–54.7
 */

import type {
  InferenceTicket,
  InferencePriority,
  GPUDevice,
  LoadedModel,
  ThrottleLevel,
} from '@may/types';
import type {
  IComputeIdGenerator,
  IComputeClock,
  ITelemetryPublisher,
  IComputeStore,
} from './interfaces/index.js';

export interface ComputeConfig {
  readonly maxConcurrentNormal: number;
  readonly maxConcurrentReduced: number;
  readonly maxConcurrentMinimal: number;
}

export interface ComputeFabricServiceDeps {
  readonly idGenerator: IComputeIdGenerator;
  readonly clock: IComputeClock;
  readonly telemetryPublisher: ITelemetryPublisher;
  readonly store: IComputeStore;
  readonly config?: Partial<ComputeConfig>;
}

export class ComputeFabricService {
  private readonly idGenerator: IComputeIdGenerator;
  private readonly clock: IComputeClock;
  private readonly telemetryPublisher: ITelemetryPublisher;
  private readonly store: IComputeStore;
  private readonly config: ComputeConfig;

  private queue: InferenceTicket[] = [];
  private runningTickets = new Map<string, InferenceTicket>();
  private throttleLevel: ThrottleLevel = 'NORMAL';

  constructor(deps: ComputeFabricServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.telemetryPublisher = deps.telemetryPublisher;
    this.store = deps.store;
    this.config = {
      maxConcurrentNormal: deps.config?.maxConcurrentNormal ?? 4,
      maxConcurrentReduced: deps.config?.maxConcurrentNormal ?? 2,
      maxConcurrentMinimal: deps.config?.maxConcurrentMinimal ?? 1,
    };
  }

  setThrottleLevel(level: ThrottleLevel) {
    this.throttleLevel = level;
  }

  /**
   * Submits an inference request and returns a ticket.
   *
   * @see Requirement 54.1, 54.4
   */
  async requestInference(
    requestId: string,
    priority: InferencePriority,
    modelId: string,
    vramRequiredMb: number
  ): Promise<InferenceTicket> {
    const ticketId = this.idGenerator.uuid();
    
    const ticket: InferenceTicket = {
      ticket_id: ticketId,
      request_id: requestId,
      priority,
      target_device: 'undecided',
      model_id: modelId,
      queue_position: this.queue.length,
      estimated_wait_ms: priority === 'interactive' ? 50 : 500,
      status: 'queued',
    };

    this.queue.push(ticket);

    // Emit telemetry
    await this.telemetryPublisher.publishTelemetry({
      type: 'inference_ticket_queued',
      ticket_id: ticketId,
      model_id: modelId,
      priority,
      timestamp: this.clock.nowISO(),
    });

    await this.processQueue(vramRequiredMb);

    // Return the updated ticket status
    const runningOrCompleted = this.runningTickets.get(ticketId) || this.queue.find(t => t.ticket_id === ticketId);
    return runningOrCompleted || ticket;
  }

  /**
   * Processes the queue, respecting priority and throttle levels.
   *
   * @see Requirement 54.3, 54.4, 54.5, 54.6, 54.7
   */
  async processQueue(vramRequiredMb: number = 2048): Promise<void> {
    const inventory = await this.store.getInventory();

    // 1. Respect Throttle_Level concurrency limits (Requirement 54.6)
    let maxConcurrent = this.config.maxConcurrentNormal;
    if (this.throttleLevel === 'REDUCED') {
      maxConcurrent = this.config.maxConcurrentReduced;
    } else if (this.throttleLevel === 'MINIMAL' || this.throttleLevel === 'EMERGENCY') {
      maxConcurrent = this.config.maxConcurrentMinimal;
    }

    if (this.runningTickets.size >= maxConcurrent) {
      return; // Queue is full, cannot execute more now
    }

    // 2. Sort queue: interactive > background (Requirement 54.4, Property 97)
    // No background ticket can start if there is an interactive ticket waiting.
    this.queue.sort((a, b) => {
      if (a.priority === 'interactive' && b.priority === 'background') return -1;
      if (a.priority === 'background' && b.priority === 'interactive') return 1;
      return 0; // maintain registration order
    });

    // Update queue positions
    this.queue = this.queue.map((t, idx) => ({ ...t, queue_position: idx }));

    const hasWaitingInteractive = this.queue.some(t => t.priority === 'interactive' && t.status === 'queued');

    const nextTicketsToProcess = [...this.queue];

    for (const ticket of nextTicketsToProcess) {
      if (this.runningTickets.size >= maxConcurrent) {
        break;
      }

      if (ticket.status !== 'queued') {
        continue;
      }

      // Property 97: No background starts while interactive waits
      if (ticket.priority === 'background' && hasWaitingInteractive) {
        continue;
      }

      // Try scheduling on GPU
      let scheduledDevice: GPUDevice | undefined;
      const gpuDevices = inventory.gpu_devices;

      for (const gpu of gpuDevices) {
        // Simple logic: VRAM check & utilization check
        if (gpu.vram_available_mb >= vramRequiredMb && gpu.utilization_percent < 85) {
          scheduledDevice = gpu;
          break;
        }
      }

      let updatedTicket: InferenceTicket;

      if (scheduledDevice) {
        // 3. GPU scheduling & Model loading management (Requirement 54.2, 54.3)
        // Allocate VRAM
        const updatedGpu = {
          ...scheduledDevice,
          vram_available_mb: scheduledDevice.vram_available_mb - vramRequiredMb,
          utilization_percent: Math.min(100, scheduledDevice.utilization_percent + 15),
        };

        const updatedGpus = gpuDevices.map(g => g.device_id === scheduledDevice!.device_id ? updatedGpu : g);

        // Load model
        const modelLoaded: LoadedModel = {
          model_id: ticket.model_id,
          device_id: scheduledDevice.device_id,
          vram_consumed_mb: vramRequiredMb,
          last_used: this.clock.nowISO(),
          load_time_ms: 150,
        };

        const updatedModels = [...inventory.loaded_models, modelLoaded];

        await this.store.saveInventory({
          ...inventory,
          gpu_devices: updatedGpus,
          loaded_models: updatedModels,
        });

        updatedTicket = {
          ...ticket,
          status: 'running',
          target_device: scheduledDevice.device_id,
        };
      } else {
        // 4. Fallback routing to CPU/cloud (Requirement 54.5, Property 98)
        updatedTicket = {
          ...ticket,
          status: 'fallback',
          target_device: 'cpu_fallback',
        };
      }

      // Update collections
      this.queue = this.queue.filter(t => t.ticket_id !== ticket.ticket_id);
      this.runningTickets.set(ticket.ticket_id, updatedTicket);

      // Emit allocation telemetry
      await this.telemetryPublisher.publishTelemetry({
        type: 'inference_ticket_allocated',
        ticket_id: updatedTicket.ticket_id,
        status: updatedTicket.status,
        target_device: updatedTicket.target_device,
        timestamp: this.clock.nowISO(),
      });
    }
  }

  async completeInference(ticketId: string): Promise<void> {
    const running = this.runningTickets.get(ticketId);
    if (!running) return;

    this.runningTickets.delete(ticketId);

    // Free up resource in inventory if GPU was used
    if (running.target_device !== 'cpu_fallback') {
      const inventory = await this.store.getInventory();
      const updatedGpus = inventory.gpu_devices.map(g => {
        if (g.device_id === running.target_device) {
          return {
            ...g,
            vram_available_mb: Math.min(g.vram_total_mb, g.vram_available_mb + 2048),
            utilization_percent: Math.max(0, g.utilization_percent - 15),
          };
        }
        return g;
      });

      await this.store.saveInventory({
        ...inventory,
        gpu_devices: updatedGpus,
      });
    }

    await this.telemetryPublisher.publishTelemetry({
      type: 'inference_ticket_completed',
      ticket_id: ticketId,
      timestamp: this.clock.nowISO(),
    });
  }

  getRunningTicketsCount(): number {
    return this.runningTickets.size;
  }
}
