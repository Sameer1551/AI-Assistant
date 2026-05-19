/**
 * @module proactive-intelligence-service
 * Proactive_Intelligence_Service: Anticipates user needs and delivers suggestions.
 *
 * @see Requirements 39.1–39.7
 */

import type { ProactiveSignal, DeliveryDecision, InterruptBudgetStatus } from '@may/types';
import { toUnitScore } from '@may/types';
import type {
  IProactiveIdGenerator,
  IProactiveClock,
  IAuditPublisher,
  UserContext,
} from './interfaces/index.js';

export interface ProactiveConfig {
  readonly maxPerHour: number;
  readonly baseThreshold: number;
}

export interface ProactiveServiceDeps {
  readonly idGenerator: IProactiveIdGenerator;
  readonly clock: IProactiveClock;
  readonly auditPublisher: IAuditPublisher;
  readonly config?: Partial<ProactiveConfig>;
}

export class ProactiveIntelligenceService {
  private readonly idGenerator: IProactiveIdGenerator;
  private readonly clock: IProactiveClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly config: ProactiveConfig;

  // principal_id -> { count, lastResetMs }
  private hourlyCounts = new Map<string, { count: number; lastResetMs: number }>();
  // principal_id -> consecutive dismissals
  private consecutiveDismissals = new Map<string, number>();

  constructor(deps: ProactiveServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.config = {
      maxPerHour: deps.config?.maxPerHour ?? 2,
      baseThreshold: deps.config?.baseThreshold ?? 0.65,
    };
  }

  /** Clamp value to [0.0, 1.0] */
  private clamp(v: number): number {
    return Math.max(0.0, Math.min(1.0, v));
  }

  private getCurrentThreshold(principalId: string): number {
    const dismissals = this.consecutiveDismissals.get(principalId) ?? 0;
    const adjustments = Math.floor(dismissals / 3);
    return this.clamp(this.config.baseThreshold + (adjustments * 0.1));
  }

  private updateHourlyCount(principalId: string) {
    const now = this.clock.nowMs();
    const entry = this.hourlyCounts.get(principalId) ?? { count: 0, lastResetMs: now };

    if (now - entry.lastResetMs > 3600000) {
      entry.count = 0;
      entry.lastResetMs = now;
    }

    this.hourlyCounts.set(principalId, entry);
    return entry;
  }

  /**
   * Evaluate and potentially deliver a proactive signal.
   *
   * @see Requirement 39.1 (budget enforcement)
   * @see Requirement 39.2 (deep focus suppression)
   * @see Requirement 39.3 (score computation)
   * @see Requirement 39.5 (audit logging)
   */
  async evaluateSignal(
    tenantId: string,
    principalId: string,
    context: UserContext,
    signalInput: {
      source: string;
      urgency: number;
      relevance: number;
      recency_factor: number;
      content: string;
    }
  ): Promise<{ decision: DeliveryDecision; signal: ProactiveSignal }> {
    const computedScoreRaw = signalInput.urgency * signalInput.relevance * signalInput.recency_factor;
    const computedScore = this.clamp(computedScoreRaw);

    const signal: ProactiveSignal = {
      signal_id: this.idGenerator.uuid(),
      source: signalInput.source,
      urgency: toUnitScore(this.clamp(signalInput.urgency)),
      relevance: toUnitScore(this.clamp(signalInput.relevance)),
      recency_factor: toUnitScore(this.clamp(signalInput.recency_factor)),
      computed_score: toUnitScore(computedScore),
      content: signalInput.content,
      timestamp: this.clock.nowISO(),
    };

    let decisionType: 'delivered' | 'suppressed' = 'suppressed';
    let reason: string | undefined;

    const threshold = this.getCurrentThreshold(principalId);
    const hourlyEntry = this.updateHourlyCount(principalId);
    
    // Deep focus check
    const isDeepFocus = context.focusDepth > 0.75 && context.lastKeystrokeMinutesAgo < 5;
    
    if (computedScore < threshold) {
      reason = 'below_threshold';
    } else if (isDeepFocus && signalInput.urgency <= 0.9) {
      reason = 'deep_focus';
    } else if (hourlyEntry.count >= this.config.maxPerHour && signalInput.urgency <= 0.9) {
      reason = 'budget_exceeded';
    } else {
      decisionType = 'delivered';
      hourlyEntry.count++;
      this.hourlyCounts.set(principalId, hourlyEntry);
    }

    const decision: DeliveryDecision = {
      signal_id: signal.signal_id,
      decision: decisionType,
      reason,
      timestamp: this.clock.nowISO(),
    };

    // Log every delivered/suppressed signal to Audit_Service (Requirement 39.5)
    await this.auditPublisher.publishAudit({
      type: 'proactive_decision',
      tenantId,
      principalId,
      decision,
    });

    return { decision, signal };
  }

  /**
   * Handle user dismissal of a proactive signal.
   *
   * @see Requirement 39.7 (threshold adjustment after 3 dismissals)
   */
  async handleDismissal(principalId: string): Promise<void> {
    const dismissals = (this.consecutiveDismissals.get(principalId) ?? 0) + 1;
    this.consecutiveDismissals.set(principalId, dismissals);
  }

  /**
   * Handle user engagement (acceptance) of a proactive signal.
   * Resets the consecutive dismissal counter.
   */
  async handleEngagement(principalId: string): Promise<void> {
    this.consecutiveDismissals.set(principalId, 0);
  }

  getBudgetStatus(principalId: string): InterruptBudgetStatus {
    const entry = this.hourlyCounts.get(principalId) ?? { count: 0, lastResetMs: this.clock.nowMs() };
    const threshold = this.getCurrentThreshold(principalId);
    const dismissals = this.consecutiveDismissals.get(principalId) ?? 0;
    
    return {
      principal_id: principalId,
      current_hour_count: entry.count,
      max_per_hour: this.config.maxPerHour,
      score_threshold: threshold,
      session_threshold_adjustment: Math.floor(dismissals / 3) * 0.1,
    };
  }
}
