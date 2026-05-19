/**
 * @module reflection-service
 * Reflection_Service: Reflective reasoning and pattern detection.
 *
 * @see Requirements 46.1–46.5
 */

import type { ReflectionRecord, UserSignal } from '@may/types';
import type {
  IReflectionIdGenerator,
  IReflectionClock,
  IAuditPublisher,
  ISelfImprovementPublisher,
  IReflectionStore,
} from './interfaces/index.js';

export interface ReflectionConfig {
  readonly retentionDays: number;
}

export interface ReflectionServiceDeps {
  readonly idGenerator: IReflectionIdGenerator;
  readonly clock: IReflectionClock;
  readonly auditPublisher: IAuditPublisher;
  readonly selfImprovementPublisher: ISelfImprovementPublisher;
  readonly store: IReflectionStore;
  readonly config?: Partial<ReflectionConfig>;
}

export class ReflectionService {
  private readonly idGenerator: IReflectionIdGenerator;
  private readonly clock: IReflectionClock;
  private readonly selfImprovementPublisher: ISelfImprovementPublisher;
  private readonly store: IReflectionStore;
  private readonly config: ReflectionConfig;

  constructor(deps: ReflectionServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.selfImprovementPublisher = deps.selfImprovementPublisher;
    this.store = deps.store;
    this.config = {
      retentionDays: deps.config?.retentionDays ?? 90,
    };
  }

  private clamp(v: number): number {
    return Math.max(0.0, Math.min(1.0, v));
  }

  /**
   * Produce a reflection record for an action.
   *
   * @see Requirement 46.2 (completeness)
   * @see Requirement 46.5 (persistence & retention)
   */
  async reflectOnAction(
    tenantId: string,
    principalId: string,
    params: {
      actionId: string;
      actionDescription: string;
      intendedOutcome: string;
      actualOutcome: string;
      userSignal: UserSignal;
      usefulnessScore: number;
      lesson: string;
      simulationResultId?: string;
      predictionAccuracy?: number;
    }
  ): Promise<ReflectionRecord> {
    const retentionMs = this.config.retentionDays * 24 * 3600 * 1000;
    const expiresAt = new Date(this.clock.nowMs() + retentionMs).toISOString();

    const record: ReflectionRecord = {
      reflection_id: this.idGenerator.uuid(),
      tenant_id: tenantId,
      principal_id: principalId,
      action_id: params.actionId,
      action_description: params.actionDescription,
      intended_outcome: params.intendedOutcome,
      actual_outcome: params.actualOutcome,
      user_signal: params.userSignal,
      usefulness_score: this.clamp(params.usefulnessScore),
      lesson: params.lesson,
      simulation_result_id: params.simulationResultId,
      prediction_accuracy: params.predictionAccuracy !== undefined ? this.clamp(params.predictionAccuracy) : undefined,
      timestamp: this.clock.nowISO(),
      expires_at: expiresAt,
    };

    await this.store.saveReflection(record);

    // Requirement 46.4: Feed lessons into Self_Improvement_Service
    await this.selfImprovementPublisher.publishLesson(record.lesson, record.usefulness_score);

    return record;
  }

  /**
   * Identify failure patterns over time windows.
   * Simple baseline implementation looking for repeated 'rejected' user signals.
   *
   * @see Requirement 46.3
   */
  async identifyFailurePatterns(tenantId: string, principalId: string): Promise<{ pattern_id: string; description: string; occurrence_count: number; first_seen: string; last_seen: string; affected_action_types: readonly string[]; suggested_mitigation: string }[]> {
    const records = await this.store.getReflections(tenantId, principalId);
    const failures = records.filter(r => r.user_signal === 'rejected' || r.usefulness_score < 0.3);

    if (failures.length === 0) return [];

    // Trivial group-by "lesson" for demo purposes of pattern detection
    const grouped = new Map<string, ReflectionRecord[]>();
    for (const f of failures) {
      const arr = grouped.get(f.lesson) ?? [];
      arr.push(f);
      grouped.set(f.lesson, arr);
    }

    const patterns: { pattern_id: string; description: string; occurrence_count: number; first_seen: string; last_seen: string; affected_action_types: readonly string[]; suggested_mitigation: string }[] = [];
    for (const [lesson, group] of grouped.entries()) {
      if (group.length >= 3) {
        const sorted = group.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        patterns.push({
          pattern_id: this.idGenerator.uuid(),
          description: `Repeated failure: ${lesson}`,
          occurrence_count: group.length,
          first_seen: sorted[0]!.timestamp,
          last_seen: sorted[sorted.length - 1]!.timestamp,
          affected_action_types: ['generic_action'],
          suggested_mitigation: `Review and adjust strategy for: ${lesson}`,
        });
      }
    }

    return patterns;
  }
}
