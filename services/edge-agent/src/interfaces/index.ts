export interface IEdgeIdGenerator {
  uuid(): string;
}

export interface IEdgeClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface ISensorSource {
  isAvailable(): boolean;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
}
