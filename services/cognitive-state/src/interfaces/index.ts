export interface ObservableSignals {
  /** Keystrokes per minute */
  readonly keystrokeVelocity: number;
  /** Number of unique applications focused in the last 60s */
  readonly appSwitchCount: number;
  /** Number of errors/backspaces in the last 60s */
  readonly errorFrequency: number;
  /** Duration of the current continuous session in minutes */
  readonly sessionDurationMinutes: number;
  /** Minutes until next scheduled meeting/event */
  readonly minutesToNextMeeting: number;
}

export interface ICognitiveIdGenerator {
  uuid(): string;
}

export interface ICognitiveClock {
  nowISO(): string;
}

export interface IProactiveIntelligencePublisher {
  publishInterruptionTolerance(tenantId: string, principalId: string, tolerance: number): Promise<void>;
}
