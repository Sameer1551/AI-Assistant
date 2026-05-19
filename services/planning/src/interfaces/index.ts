import type { PlanTree } from '@may/types';

export interface IPlanningIdGenerator {
  uuid(): string;
}

export interface IPlanningClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface IPlanningStore {
  savePlan(plan: PlanTree): Promise<void>;
  getPlan(planId: string): Promise<PlanTree | undefined>;
}
