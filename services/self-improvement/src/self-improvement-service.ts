/**
 * @module self-improvement-service
 * Self_Improvement_Service: Automated prompt improvement and benchmark gating.
 *
 * @see Requirements 49.1–49.7
 */

import type { ImprovementCycle, PromptVersion } from '@may/types';
import type {
  ISelfImprovementIdGenerator,
  ISelfImprovementClock,
  IAuditPublisher,
  ITelemetryPublisher,
  IBenchmarkEngine,
  ISelfImprovementStore,
} from './interfaces/index.js';

export interface SelfImprovementServiceDeps {
  readonly idGenerator: ISelfImprovementIdGenerator;
  readonly clock: ISelfImprovementClock;
  readonly auditPublisher: IAuditPublisher;
  readonly telemetryPublisher: ITelemetryPublisher;
  readonly benchmarkEngine: IBenchmarkEngine;
  readonly store: ISelfImprovementStore;
}

export class SelfImprovementService {
  private readonly idGenerator: ISelfImprovementIdGenerator;
  private readonly clock: ISelfImprovementClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly telemetryPublisher: ITelemetryPublisher;
  private readonly benchmarkEngine: IBenchmarkEngine;
  private readonly store: ISelfImprovementStore;

  constructor(deps: SelfImprovementServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.telemetryPublisher = deps.telemetryPublisher;
    this.benchmarkEngine = deps.benchmarkEngine;
    this.store = deps.store;
  }

  /**
   * Run the improvement cycle.
   *
   * @see Requirements 49.2, 49.3, 49.6, 49.7
   */
  async runImprovementCycle(proposedPrompt: string): Promise<ImprovementCycle | null> {
    const corrections = await this.store.getCorrectionsCount();
    
    // Property 86: Require >= 10 corrections before initiating cycle
    if (corrections < 10) {
      return null;
    }

    const activePrompt = await this.store.getActivePrompt();
    if (!activePrompt) {
      throw new Error("No active prompt baseline found");
    }

    // Auto-rollback on score drop (Requirement 49.5 / Property 84)
    // We re-evaluate the baseline. If it dropped below its own recorded score by a margin,
    // we would roll it back. Here we simplify by checking if we have recent versions to rollback to.
    const currentBaselineScore = await this.benchmarkEngine.evaluate(activePrompt.prompt_content);
    if (currentBaselineScore < activePrompt.benchmark_score - 0.05) {
      // Baseline degraded, initiate rollback
      const recent = await this.store.getRecentPrompts();
      const previous = recent.find(p => p.version_id !== activePrompt.version_id);
      if (previous) {
        await this.store.savePromptVersion({ ...activePrompt, is_active: false, rolled_back_at: this.clock.nowISO() });
        await this.store.savePromptVersion({ ...previous, is_active: true });
        
        await this.auditPublisher.publishAudit({ type: 'prompt_rollback', from: activePrompt.version_id, to: previous.version_id });
        return null; // Cycle interrupted by rollback
      }
    }

    const candidateScore = await this.benchmarkEngine.evaluate(proposedPrompt);

    let decision: 'promoted' | 'discarded' = 'discarded';
    let newPromptId: string | undefined;

    // Property 84: Benchmark-Gated Deployment
    if (candidateScore >= currentBaselineScore) {
      decision = 'promoted';
      newPromptId = this.idGenerator.uuid();
      
      const newPrompt: PromptVersion = {
        version_id: newPromptId,
        prompt_content: proposedPrompt,
        benchmark_score: candidateScore,
        created_at: this.clock.nowISO(),
        promoted_at: this.clock.nowISO(),
        is_active: true,
      };

      await this.store.savePromptVersion({ ...activePrompt, is_active: false });
      await this.store.savePromptVersion(newPrompt);
      
      // Cleanup to maintain >=10 versions (Requirement 49.2, Property 85)
      // Managed by store logic (assumed to keep top N)
    }

    const cycle: ImprovementCycle = {
      cycle_id: this.idGenerator.uuid(),
      timestamp: this.clock.nowISO(),
      phase: 'COMPLETED',
      baseline_score: currentBaselineScore,
      candidate_score: candidateScore,
      decision,
      prompt_version_before: activePrompt.version_id,
      prompt_version_after: newPromptId,
      corrections_analyzed: corrections,
    };

    await this.store.saveCycle(cycle);
    await this.store.clearCorrections();

    // Telemetry (Requirement 49.4)
    await this.telemetryPublisher.publishTelemetry({
      type: 'improvement_cycle_completed',
      cycle,
    });

    return cycle;
  }
}
