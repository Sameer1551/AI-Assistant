

export interface IHudIdGenerator {
  uuid(): string;
}

export interface IHudClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IEdgeAgentClient {
  pauseAgent(): Promise<void>;
  resumeAgent(): Promise<void>;
  triggerKillSwitch(): Promise<void>;
}
