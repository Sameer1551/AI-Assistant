import type { ThrottleLevel } from '@may/types';

export interface ResearchExperiment {
  experiment_id: string;
  tenant_id: string;
  hypothesis: string;
  status: 'running' | 'completed' | 'timeout' | 'failed';
  baseline_score: number;
  experimental_score?: number;
  started_at: string;
  completed_at?: string;
  positive_result: boolean;
}

export interface IResearchIdGenerator {
  uuid(): string;
}

export interface IResearchClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface IResourceGovernor {
  getCurrentThrottleLevel(): Promise<ThrottleLevel>;
  isUserActive(): Promise<boolean>;
}

export interface ISelfImprovementPublisher {
  proposeImprovement(hypothesis: string, proof: string): Promise<void>;
}

export interface IEvalService {
  runExperiment(hypothesis: string): Promise<{ score: number }>;
  getBaselineScore(): Promise<number>;
}
