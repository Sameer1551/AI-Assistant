export interface IPersonalityIdGenerator {
  uuid(): string;
}

export interface IPersonalityClock {
  nowISO(): string;
}

export interface IPersonalityAlertEmitter {
  emitDriftAlert(benchmarkId: string, score: number, threshold: number): Promise<void>;
}

export interface StyleSelectionContext {
  readonly timeOfDay: number; // 0-23
  readonly focusDepth: number; // [0.0, 1.0]
  readonly stressLevel: number; // [0.0, 1.0]
}
