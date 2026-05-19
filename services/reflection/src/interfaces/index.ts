import type { ReflectionRecord, FailurePattern } from '@may/types';

export interface IReflectionIdGenerator {
  uuid(): string;
}

export interface IReflectionClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface ISelfImprovementPublisher {
  publishLesson(lesson: string, score: number): Promise<void>;
}

export interface IReflectionStore {
  saveReflection(record: ReflectionRecord): Promise<void>;
  getReflections(tenantId: string, principalId: string): Promise<ReflectionRecord[]>;
}
