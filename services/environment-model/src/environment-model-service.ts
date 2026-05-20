/**
 * @module environment-model-service
 * Environment_Model_Service: Hardware/context sensing, classification, and eventing.
 *
 * @see Requirements 55.1–55.6
 */

import type { EnvironmentState, EnvironmentChangeEvent, PhysicalEnvironment } from '@may/types';
import type { IEnvironmentIdGenerator, IEnvironmentClock, IEventPublisher } from './interfaces/index.js';

export class EnvironmentModelService {
  private readonly idGenerator: IEnvironmentIdGenerator;
  private readonly clock: IEnvironmentClock;
  private readonly publisher: IEventPublisher;

  private currentState: EnvironmentState | null = null;
  private hasConsent: boolean = true;

  constructor(deps: {
    readonly idGenerator: IEnvironmentIdGenerator;
    readonly clock: IEnvironmentClock;
    readonly publisher: IEventPublisher;
  }) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.publisher = deps.publisher;
  }

  setConsent(hasConsent: boolean): void {
    this.hasConsent = hasConsent;
    if (!hasConsent) {
      // Privacy/Consent: clear state immediately (Requirement 55.6)
      this.currentState = null;
    }
  }

  /**
   * Classify physical environment based on hardware and connection properties.
   *
   * @see Requirement 55.3, Property 99
   */
  classifyPhysicalEnvironment(params: {
    readonly power_state: 'ac' | 'battery' | 'unknown';
    readonly monitor_count: number;
    readonly internet_connectivity: 'high_speed' | 'low_speed' | 'offline';
  }): PhysicalEnvironment {
    // If battery power is active and monitors count <= 1, classify as 'mobile'
    if (params.power_state === 'battery' && params.monitor_count <= 1) {
      return 'mobile';
    }
    // If AC power is active and monitor count >= 2, classify as 'home_office'
    if (params.power_state === 'ac' && params.monitor_count >= 2) {
      return 'home_office';
    }
    // Default or fallback
    return 'unknown';
  }

  /**
   * Updates current environment state and triggers change events if significant changes occur.
   *
   * @see Requirement 55.1, 55.2, 55.5, Property 100
   */
  async updateState(params: {
    readonly tenant_id: string;
    readonly principal_id: string;
    readonly hardware_tier: 'low' | 'mid' | 'high';
    readonly gpu_available: boolean;
    readonly gpu_vram_mb?: number;
    readonly battery_level?: number;
    readonly power_state: 'ac' | 'battery' | 'unknown';
    readonly thermal_state: 'nominal' | 'warm' | 'hot' | 'critical';
    readonly internet_connectivity: 'high_speed' | 'low_speed' | 'offline';
    readonly monitor_count: number;
  }): Promise<EnvironmentState | null> {
    if (!this.hasConsent) {
      return null; // Consent Gated
    }

    const physical_env = this.classifyPhysicalEnvironment({
      power_state: params.power_state,
      monitor_count: params.monitor_count,
      internet_connectivity: params.internet_connectivity,
    });

    const nextState: EnvironmentState = {
      state_id: this.idGenerator.uuid(),
      tenant_id: params.tenant_id,
      principal_id: params.principal_id,
      timestamp: this.clock.nowISO(),
      hardware_tier: params.hardware_tier,
      gpu_available: params.gpu_available,
      gpu_vram_mb: params.gpu_vram_mb,
      battery_level: params.battery_level,
      power_state: params.power_state,
      thermal_state: params.thermal_state,
      internet_connectivity: params.internet_connectivity,
      monitor_count: params.monitor_count,
      physical_environment: physical_env,
    };

    const previousState = this.currentState;
    this.currentState = nextState;

    if (previousState) {
      // Check for significant changes
      // Significant change properties: power_state, internet_connectivity, thermal_state, physical_environment
      const changes: { prop: string; prev: string; curr: string }[] = [];

      if (previousState.power_state !== nextState.power_state) {
        changes.push({ prop: 'power_state', prev: previousState.power_state, curr: nextState.power_state });
      }
      if (previousState.internet_connectivity !== nextState.internet_connectivity) {
        changes.push({ prop: 'internet_connectivity', prev: previousState.internet_connectivity, curr: nextState.internet_connectivity });
      }
      if (previousState.thermal_state !== nextState.thermal_state) {
        changes.push({ prop: 'thermal_state', prev: previousState.thermal_state, curr: nextState.thermal_state });
      }
      if (previousState.physical_environment !== nextState.physical_environment) {
        changes.push({ prop: 'physical_environment', prev: previousState.physical_environment, curr: nextState.physical_environment });
      }

      for (const change of changes) {
        const changeEvent: EnvironmentChangeEvent = {
          event_id: this.idGenerator.uuid(),
          change_type: `${change.prop}_change`,
          previous_value: change.prev,
          new_value: change.curr,
          timestamp: this.clock.nowISO(),
        };

        // Requirement 55.5 / Property 100: Emit significant change events immediately (well within 5s window)
        await this.publisher.publishChangeEvent(changeEvent);
        
        // Notify Resource Governor Service
        await this.publisher.publishToResourceGovernor(changeEvent);
      }
    }

    return nextState;
  }

  getCurrentState(): EnvironmentState | null {
    if (!this.hasConsent) return null;
    return this.currentState;
  }
}
