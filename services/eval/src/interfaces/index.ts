export interface IEvalIdGenerator {
  uuid(): string;
}

export interface IEvalClock {
  nowISO(): string;
  nowMs(): number;
}

export interface GoldenEvalItem {
  readonly itemId: string;
  readonly input: string;
  readonly expectedOutput: string;
}

export interface GoldenEvalSet {
  readonly setId: string;
  readonly type: 'stt' | 'tts' | 'model_routing' | 'memory_retrieval' | 'pii_detection' | 'prompt_injection';
  readonly version: number;
  readonly items: GoldenEvalItem[];
  readonly minPassingScore: number; // e.g. 0.85
}

export interface EvalRunResult {
  readonly runId: string;
  readonly setId: string;
  readonly modelOrPromptId: string;
  readonly score: number;
  readonly passed: boolean;
  readonly timestamp: string;
}

export interface IEvalStore {
  saveEvalSet(set: GoldenEvalSet): Promise<void>;
  getEvalSet(type: string, version?: number): Promise<GoldenEvalSet | null>;
  saveRunResult(result: EvalRunResult): Promise<void>;
  getRunResults(modelOrPromptId: string): Promise<EvalRunResult[]>;
  purgeOlderThan(days: number): Promise<number>;
}
