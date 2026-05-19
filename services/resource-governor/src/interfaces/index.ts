import type { ThrottleLevel } from '@may/types';

export interface IGovernorIdGenerator {
  uuid(): string;
}

export interface IGovernorClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface ITelemetryPublisher {
  publishTelemetry(event: any): Promise<void>;
}

export interface ISystemMonitor {
  getCPUUsage(): Promise<number>;
  getRAMUsage(): Promise<number>;
  getGPUUsage(): Promise<number | undefined>;
  getBatteryLevel(): Promise<number | undefined>;
  getPowerState(): Promise<'ac' | 'battery' | 'unknown'>;
  getThermalState(): Promise<'nominal' | 'warm' | 'hot' | 'critical'>;
  enforcePlatformCPUCeiling(maxPercent: number): Promise<void>;
}

export interface IThrottlePublisher {
  publishThrottleLevel(level: ThrottleLevel): Promise<void>;
}
