import type { EnvironmentChangeEvent } from '@may/types';

export interface IEnvironmentIdGenerator {
  uuid(): string;
}

export interface IEnvironmentClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IEventPublisher {
  publishChangeEvent(event: EnvironmentChangeEvent): Promise<void>;
  publishToResourceGovernor(event: EnvironmentChangeEvent): Promise<void>;
}
