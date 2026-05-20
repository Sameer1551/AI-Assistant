export interface IWatchdogIdGenerator {
  uuid(): string;
}

export interface IWatchdogClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface AgentHealthStats {
  readonly activeAgentsCount: number;
  readonly longestRunningAgentId?: string;
  readonly agentsApproachingLimits: string[];
}
