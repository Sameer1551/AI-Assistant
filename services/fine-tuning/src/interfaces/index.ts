import type { LoRAAdapter, ThrottleLevel } from '@may/types';

export interface IFineTuningIdGenerator {
  uuid(): string;
}

export interface IFineTuningClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface IBenchmarkEngine {
  evaluateWithAdapter(adapterId: string): Promise<number>;
  evaluateBaseline(): Promise<number>;
}

export interface IResourceGovernor {
  getCurrentThrottleLevel(): Promise<ThrottleLevel>;
}

export interface IFineTuningStore {
  getTenantConfig(tenantId: string): Promise<{ fineTuningEnabled: boolean }>;
  saveAdapter(adapter: LoRAAdapter): Promise<void>;
  getPendingTrainingData(tenantId: string): Promise<any[]>;
  markTrainingDataReviewed(dataIds: string[]): Promise<void>;
  getAdapterVersions(): Promise<LoRAAdapter[]>;
}

export interface ILoRATrainer {
  train(trainingData: any[], baseModelId: string): Promise<{ adapterId: string, version: number }>;
}
