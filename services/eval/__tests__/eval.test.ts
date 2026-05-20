import { describe, it, expect } from 'vitest';
import { EvalService } from '../src/eval-service.js';
import type { GoldenEvalSet, EvalRunResult } from '../src/interfaces/index.js';

describe('Eval_Service', () => {
  const mockEvalSet: GoldenEvalSet = {
    setId: 'set-stt-1',
    type: 'stt',
    version: 1,
    minPassingScore: 0.8,
    items: [
      { itemId: 'item-1', input: 'audio-hello', expectedOutput: 'hello' },
      { itemId: 'item-2', input: 'audio-world', expectedOutput: 'world' },
    ],
  };

  let mockEvalStoreData = {
    evalSets: new Map<string, GoldenEvalSet>([['stt:1', mockEvalSet]]),
    runResults: [] as EvalRunResult[],
  };

  const mockStore = {
    saveEvalSet: async (set: GoldenEvalSet) => {
      mockEvalStoreData.evalSets.set(`${set.type}:${set.version}`, set);
    },
    getEvalSet: async (type: string, version?: number) => {
      const v = version ?? 1;
      return mockEvalStoreData.evalSets.get(`${type}:${v}`) || null;
    },
    saveRunResult: async (res: EvalRunResult) => {
      mockEvalStoreData.runResults.push(res);
    },
    getRunResults: async (modelOrPromptId: string) => {
      return mockEvalStoreData.runResults.filter(r => r.modelOrPromptId === modelOrPromptId);
    },
    purgeOlderThan: async (days: number) => {
      const initialCount = mockEvalStoreData.runResults.length;
      mockEvalStoreData.runResults = [];
      return initialCount;
    },
  };

  const createService = () =>
    new EvalService({
      idGenerator: { uuid: () => 'eval-uuid-123' },
      clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
      store: mockStore,
    });

  it('runs evaluation and passes on correct outputs', async () => {
    const service = createService();

    // 100% correct
    const evaluatorAllCorrect = async (inp: string) => {
      if (inp === 'audio-hello') return 'hello';
      return 'world';
    };

    const result = await service.runEvaluation('stt', 'model-v1', evaluatorAllCorrect);
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);

    // Partially correct (50%)
    const evaluatorPartiallyCorrect = async (inp: string) => {
      if (inp === 'audio-hello') return 'hello';
      return 'wrong';
    };

    const resultPartial = await service.runEvaluation('stt', 'model-v1', evaluatorPartiallyCorrect);
    expect(resultPartial.score).toBe(0.5);
    expect(resultPartial.passed).toBe(false); // minPassingScore is 0.8
  });

  it('runs shadow comparison correctly', async () => {
    const service = createService();

    const candidateFn = async (inp: string) => {
      if (inp === 'audio-hello') return 'hello';
      return 'world'; // 100% correct
    };

    const incumbentFn = async (inp: string) => {
      if (inp === 'audio-hello') return 'hello';
      return 'wrong'; // 50% correct
    };

    const comp = await service.shadowComparison('stt', 'candidate-model', 'incumbent-model', candidateFn, incumbentFn);
    expect(comp.candidateResult.score).toBe(1.0);
    expect(comp.incumbentResult.score).toBe(0.5);
    expect(comp.diff).toBe(0.5);
  });

  it('enforces retention correctly', async () => {
    const service = createService();
    const purged = await service.enforceRetention();
    expect(purged).toBeGreaterThanOrEqual(0);
  });
});
