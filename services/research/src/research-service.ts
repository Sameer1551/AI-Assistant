/**
 * @module research-service
 * Research_Service: Autonomous research and experimentation.
 *
 * @see Requirements 51.1–51.7
 */

import type {
  ResearchExperiment,
  IResearchIdGenerator,
  IResearchClock,
  IAuditPublisher,
  IResourceGovernor,
  ISelfImprovementPublisher,
  IEvalService,
} from './interfaces/index.js';

export interface ResearchConfig {
  readonly maxExperimentDurationSeconds: number;
}

export interface ResearchServiceDeps {
  readonly idGenerator: IResearchIdGenerator;
  readonly clock: IResearchClock;
  readonly auditPublisher: IAuditPublisher;
  readonly resourceGovernor: IResourceGovernor;
  readonly selfImprovementPublisher: ISelfImprovementPublisher;
  readonly evalService: IEvalService;
  readonly config?: Partial<ResearchConfig>;
}

export class ResearchService {
  private readonly idGenerator: IResearchIdGenerator;
  private readonly clock: IResearchClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly resourceGovernor: IResourceGovernor;
  private readonly selfImprovementPublisher: ISelfImprovementPublisher;
  private readonly evalService: IEvalService;
  private readonly config: ResearchConfig;

  constructor(deps: ResearchServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.resourceGovernor = deps.resourceGovernor;
    this.selfImprovementPublisher = deps.selfImprovementPublisher;
    this.evalService = deps.evalService;
    this.config = {
      maxExperimentDurationSeconds: deps.config?.maxExperimentDurationSeconds ?? 1800, // default 30 min
    };
  }

  /**
   * Run an autonomous research experiment.
   *
   * @see Requirement 51.2 (Throttle Level and user interaction)
   * @see Requirement 51.3 (Eval_Service benchmarking)
   * @see Requirement 51.4 (Feed to Self_Improvement, no direct deploy)
   * @see Requirement 51.5 (Time limits)
   */
  async runExperiment(tenantId: string, hypothesis: string): Promise<ResearchExperiment | null> {
    // 1. Throttle Level Gating (Requirement 51.2 / Property 90 equivalent)
    const throttleLevel = await this.resourceGovernor.getCurrentThrottleLevel();
    if (throttleLevel !== 'NORMAL') {
      return null;
    }

    // 2. User Activity Gating (Requirement 51.2)
    const isUserActive = await this.resourceGovernor.isUserActive();
    if (isUserActive) {
      return null;
    }

    const experimentId = this.idGenerator.uuid();
    const startMs = this.clock.nowMs();
    const baselineScore = await this.evalService.getBaselineScore();

    // 3. Execution with Timeout (Requirement 51.5)
    let timedOut = false;
    let evalResult: { score: number } | undefined;

    try {
      evalResult = await Promise.race([
        this.evalService.runExperiment(hypothesis),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), this.config.maxExperimentDurationSeconds * 1000))
      ]);
      
      if (!evalResult) {
        timedOut = true;
      }
    } catch (e) {
      evalResult = undefined;
    }

    let status: 'completed' | 'timeout' | 'failed' = 'completed';
    let positiveResult = false;

    if (timedOut) {
      status = 'timeout';
    } else if (!evalResult) {
      status = 'failed';
    } else {
      positiveResult = evalResult.score > baselineScore;
    }

    const experiment: ResearchExperiment = {
      experiment_id: experimentId,
      tenant_id: tenantId,
      hypothesis,
      status,
      baseline_score: baselineScore,
      experimental_score: evalResult?.score,
      started_at: new Date(startMs).toISOString(),
      completed_at: this.clock.nowISO(),
      positive_result: positiveResult,
    };

    // 4. Feed positive results into Self_Improvement_Service (Requirement 51.4 / Property 91)
    if (positiveResult) {
      await this.selfImprovementPublisher.proposeImprovement(
        hypothesis,
        `Achieved score ${evalResult!.score} > baseline ${baselineScore}`
      );
    }

    // 5. Audit Logging (Requirement 51.6)
    await this.auditPublisher.publishAudit({
      type: 'research_experiment',
      tenantId,
      experiment,
    });

    return experiment;
  }
}
