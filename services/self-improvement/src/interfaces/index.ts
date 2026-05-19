import type { ImprovementCycle, PromptVersion } from '@may/types';

export interface ISelfImprovementIdGenerator {
  uuid(): string;
}

export interface ISelfImprovementClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface ITelemetryPublisher {
  publishTelemetry(event: any): Promise<void>;
}

export interface IBenchmarkEngine {
  evaluate(promptContent: string): Promise<number>;
}

export interface ISelfImprovementStore {
  saveCycle(cycle: ImprovementCycle): Promise<void>;
  savePromptVersion(version: PromptVersion): Promise<void>;
  getActivePrompt(): Promise<PromptVersion | undefined>;
  getRecentPrompts(): Promise<PromptVersion[]>;
  getCorrectionsCount(): Promise<number>;
  clearCorrections(): Promise<void>;
}
