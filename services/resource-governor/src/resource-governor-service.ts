/**
 * @module resource-governor-service
 * Resource_Governor_Service: Resource monitoring and adaptive throttling.
 *
 * @see Requirements 52.1–52.7
 */

import type { ThrottleLevel, ThrottleConfig } from '@may/types';
import type {
  IGovernorIdGenerator,
  IGovernorClock,
  IAuditPublisher,
  ITelemetryPublisher,
  ISystemMonitor,
  IThrottlePublisher,
} from './interfaces/index.js';

export interface ResourceGovernorServiceDeps {
  readonly idGenerator: IGovernorIdGenerator;
  readonly clock: IGovernorClock;
  readonly auditPublisher: IAuditPublisher;
  readonly telemetryPublisher: ITelemetryPublisher;
  readonly monitor: ISystemMonitor;
  readonly publisher: IThrottlePublisher;
  readonly config?: Partial<ThrottleConfig>;
}

export class ResourceGovernorService {
  private readonly idGenerator: IGovernorIdGenerator;
  private readonly clock: IGovernorClock;
  private readonly telemetryPublisher: ITelemetryPublisher;
  private readonly monitor: ISystemMonitor;
  private readonly publisher: IThrottlePublisher;
  private readonly config: ThrottleConfig;

  private currentLevel: ThrottleLevel = 'NORMAL';

  constructor(deps: ResourceGovernorServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.telemetryPublisher = deps.telemetryPublisher;
    this.monitor = deps.monitor;
    this.publisher = deps.publisher;
    this.config = {
      cpu_thresholds: deps.config?.cpu_thresholds ?? { reduced: 60, minimal: 75, emergency: 85 },
      ram_thresholds: deps.config?.ram_thresholds ?? { reduced: 70, minimal: 80, emergency: 88 },
      hysteresis_margin: deps.config?.hysteresis_margin ?? 5,
      max_platform_cpu_percent: deps.config?.max_platform_cpu_percent ?? 25,
    };
  }

  getCurrentLevel(): ThrottleLevel {
    return this.currentLevel;
  }

  /**
   * Evaluate system resources and apply throttle level.
   * Expected to be called every ≤3s (Requirement 52.1)
   */
  async evaluateResources(): Promise<void> {
    const cpu = await this.monitor.getCPUUsage();
    const ram = await this.monitor.getRAMUsage();

    // Requirement 52.5 (Enforce platform max CPU)
    await this.monitor.enforcePlatformCPUCeiling(this.config.max_platform_cpu_percent);

    let targetLevel: ThrottleLevel = 'NORMAL';
    let triggerMetric = '';
    let triggerVal = 0;
    let thresholdUsed = 0;

    // Requirement 52.6: Emergency on CPU > 85% or RAM > 88%
    if (cpu >= this.config.cpu_thresholds.emergency) {
      targetLevel = 'EMERGENCY'; triggerMetric = 'cpu'; triggerVal = cpu; thresholdUsed = this.config.cpu_thresholds.emergency;
    } else if (ram >= this.config.ram_thresholds.emergency) {
      targetLevel = 'EMERGENCY'; triggerMetric = 'ram'; triggerVal = ram; thresholdUsed = this.config.ram_thresholds.emergency;
    } else if (cpu >= this.config.cpu_thresholds.minimal) {
      targetLevel = 'MINIMAL'; triggerMetric = 'cpu'; triggerVal = cpu; thresholdUsed = this.config.cpu_thresholds.minimal;
    } else if (ram >= this.config.ram_thresholds.minimal) {
      targetLevel = 'MINIMAL'; triggerMetric = 'ram'; triggerVal = ram; thresholdUsed = this.config.ram_thresholds.minimal;
    } else if (cpu >= this.config.cpu_thresholds.reduced) {
      targetLevel = 'REDUCED'; triggerMetric = 'cpu'; triggerVal = cpu; thresholdUsed = this.config.cpu_thresholds.reduced;
    } else if (ram >= this.config.ram_thresholds.reduced) {
      targetLevel = 'REDUCED'; triggerMetric = 'ram'; triggerVal = ram; thresholdUsed = this.config.ram_thresholds.reduced;
    }

    // Apply Hysteresis for downgrading (improving) level (Requirement 52.3)
    if (this.currentLevel !== 'NORMAL' && targetLevel !== this.currentLevel) {
      // Determine what the current level's threshold is to see if we've dropped below the margin
      let requiredCpuDrop = 0;
      let requiredRamDrop = 0;

      if (this.currentLevel === 'EMERGENCY') {
        requiredCpuDrop = this.config.cpu_thresholds.emergency - this.config.hysteresis_margin;
        requiredRamDrop = this.config.ram_thresholds.emergency - this.config.hysteresis_margin;
      } else if (this.currentLevel === 'MINIMAL') {
        requiredCpuDrop = this.config.cpu_thresholds.minimal - this.config.hysteresis_margin;
        requiredRamDrop = this.config.ram_thresholds.minimal - this.config.hysteresis_margin;
      } else if (this.currentLevel === 'REDUCED') {
        requiredCpuDrop = this.config.cpu_thresholds.reduced - this.config.hysteresis_margin;
        requiredRamDrop = this.config.ram_thresholds.reduced - this.config.hysteresis_margin;
      }

      // If we haven't dropped far enough, hold the current level
      if (cpu > requiredCpuDrop || ram > requiredRamDrop) {
        // Unless targetLevel is WORSE than current level (e.g. going from REDUCED to EMERGENCY)
        // Levels: 0=NORMAL, 1=REDUCED, 2=MINIMAL, 3=EMERGENCY
        const levels = { 'NORMAL': 0, 'REDUCED': 1, 'MINIMAL': 2, 'EMERGENCY': 3 };
        if (levels[targetLevel] < levels[this.currentLevel]) {
          targetLevel = this.currentLevel; // Maintain severity due to hysteresis
        }
      }
    }

    if (this.currentLevel !== targetLevel) {
      const prev = this.currentLevel;
      this.currentLevel = targetLevel;

      // Requirement 52.4 (Publish)
      await this.publisher.publishThrottleLevel(targetLevel);

      // Requirement 52.7 (Emit telemetry)
      await this.telemetryPublisher.publishTelemetry({
        type: 'throttle_level_transition',
        transition_id: this.idGenerator.uuid(),
        previous_level: prev,
        new_level: targetLevel,
        triggering_metric: triggerMetric,
        triggering_value: triggerVal,
        threshold: thresholdUsed,
        timestamp: this.clock.nowISO(),
      });
    }
  }
}
