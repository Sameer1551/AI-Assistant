import type { Goal } from '@may/types';

export interface IGoalIdGenerator {
  uuid(): string;
}

export interface IGoalClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface ILLMGoalDecomposer {
  decomposeGoal(title: string, description: string): Promise<Array<{ description: string; success_criteria: string; estimated_hours: number }>>;
}

export interface IGoalStore {
  saveGoal(goal: Goal): Promise<void>;
  getGoal(goalId: string): Promise<Goal | undefined>;
  getGoals(tenantId: string, principalId: string): Promise<Goal[]>;
}
