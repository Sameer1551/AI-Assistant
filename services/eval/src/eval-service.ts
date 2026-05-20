/**
 * @module eval-service
 * Eval_Service: Quality gates, golden evaluation sets, shadow comparison, and retention.
 *
 * @see Requirements 29.1–29.5
 */

import type { IEvalIdGenerator, IEvalClock, IEvalStore, EvalRunResult } from './interfaces/index.js';

export class EvalService {
  private readonly idGenerator: IEvalIdGenerator;
  private readonly clock: IEvalClock;
  private readonly store: IEvalStore;

  constructor(deps: {
    readonly idGenerator: IEvalIdGenerator;
    readonly clock: IEvalClock;
    readonly store: IEvalStore;
  }) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.store = deps.store;
  }

  /**
   * Executes a golden eval set against a target model/prompt.
   * Blocks or flags on regression threshold breach.
   *
   * @see Requirement 29.1, 29.2
   */
  async runEvaluation(
    type: 'stt' | 'tts' | 'model_routing' | 'memory_retrieval' | 'pii_detection' | 'prompt_injection',
    modelOrPromptId: string,
    evaluatorFn: (input: string) => Promise<string>,
    version?: number
  ): Promise<EvalRunResult> {
    const evalSet = await this.store.getEvalSet(type, version);
    if (!evalSet) {
      throw new Error(`Golden eval set not found for type: ${type}`);
    }

    let correctCount = 0;
    const items = evalSet.items;

    for (const item of items) {
      const output = await evaluatorFn(item.input);
      // Simulating grading (exact match or simple keyword match for robustness)
      if (output.trim().toLowerCase() === item.expectedOutput.trim().toLowerCase() ||
          output.toLowerCase().includes(item.expectedOutput.toLowerCase())) {
        correctCount++;
      }
    }

    const score = items.length > 0 ? correctCount / items.length : 1.0;
    const passed = score >= evalSet.minPassingScore;

    const runResult: EvalRunResult = {
      runId: this.idGenerator.uuid(),
      setId: evalSet.setId,
      modelOrPromptId,
      score,
      passed,
      timestamp: this.clock.nowISO(),
    };

    await this.store.saveRunResult(runResult);
    return runResult;
  }

  /**
   * Shadow comparison: Candidate vs Incumbent.
   * Runs candidate and incumbent models/prompts on the exact same inputs to measure variance.
   *
   * @see Requirement 29.3
   */
  async shadowComparison(
    type: 'stt' | 'tts' | 'model_routing' | 'memory_retrieval' | 'pii_detection' | 'prompt_injection',
    candidateId: string,
    incumbentId: string,
    candidateFn: (input: string) => Promise<string>,
    incumbentFn: (input: string) => Promise<string>,
    version?: number
  ): Promise<{
    readonly candidateResult: EvalRunResult;
    readonly incumbentResult: EvalRunResult;
    readonly diff: number;
  }> {
    const candidateResult = await this.runEvaluation(type, candidateId, candidateFn, version);
    const incumbentResult = await this.runEvaluation(type, incumbentId, incumbentFn, version);

    const diff = candidateResult.score - incumbentResult.score;

    return {
      candidateResult,
      incumbentResult,
      diff,
    };
  }

  /**
   * Enforces evaluation result retention ≥365 days.
   *
   * @see Requirement 29.4
   */
  async enforceRetention(): Promise<number> {
    return await this.store.purgeOlderThan(365);
  }
}
