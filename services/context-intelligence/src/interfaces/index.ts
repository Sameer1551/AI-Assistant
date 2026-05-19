export interface IContextProvider {
  readonly providerId: string;
  readonly fields: readonly string[];
  fetchContext(tenantId: string, principalId: string): Promise<Record<string, { value: unknown; confidence: number }>>;
}

export interface IContextIdGenerator {
  uuid(): string;
}

export interface IContextClock {
  nowISO(): string;
}
