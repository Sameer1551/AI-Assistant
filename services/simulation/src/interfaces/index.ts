import type { SimulationResult } from '@may/types';

export interface ISimulationIdGenerator {
  uuid(): string;
}

export interface ISimulationClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface IActionPredictor {
  predict(action: any): Promise<Partial<SimulationResult>>;
}
