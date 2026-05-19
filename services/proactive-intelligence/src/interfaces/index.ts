export interface IProactiveIdGenerator {
  uuid(): string;
}

export interface IProactiveClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface UserContext {
  readonly focusDepth: number;
  readonly lastKeystrokeMinutesAgo: number;
}
