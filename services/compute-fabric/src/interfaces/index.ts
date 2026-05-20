import type { ResourceInventory } from '@may/types';

export interface IComputeIdGenerator {
  uuid(): string;
}

export interface IComputeClock {
  nowISO(): string;
  nowMs(): number;
}

export interface ITelemetryPublisher {
  publishTelemetry(event: any): Promise<void>;
}

export interface IComputeStore {
  getInventory(): Promise<ResourceInventory>;
  saveInventory(inventory: ResourceInventory): Promise<void>;
}
