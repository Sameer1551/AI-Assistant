/**
 * @module goal-engine-service
 * Goal_Engine_Service: Manages goals and milestone decomposition.
 *
 * @see Requirements 44.1–44.8
 */

import type { Goal, Milestone, GoalStatus, NextActionSuggestion, MilestoneStatus } from '@may/types';
import type {
  IGoalIdGenerator,
  IGoalClock,
  IAuditPublisher,
  ILLMGoalDecomposer,
  IGoalStore,
} from './interfaces/index.js';

export interface GoalEngineConfig {
  readonly blockedThresholdDays: number;
}

export interface GoalEngineDeps {
  readonly idGenerator: IGoalIdGenerator;
  readonly clock: IGoalClock;
  readonly auditPublisher: IAuditPublisher;
  readonly llmDecomposer: ILLMGoalDecomposer;
  readonly store: IGoalStore;
  readonly config?: Partial<GoalEngineConfig>;
}

export class GoalEngineService {
  private readonly idGenerator: IGoalIdGenerator;
  private readonly clock: IGoalClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly llmDecomposer: ILLMGoalDecomposer;
  private readonly store: IGoalStore;
  private readonly config: GoalEngineConfig;

  constructor(deps: GoalEngineDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.llmDecomposer = deps.llmDecomposer;
    this.store = deps.store;
    this.config = {
      blockedThresholdDays: deps.config?.blockedThresholdDays ?? 7,
    };
  }

  /** Clamp to [0, 1] */
  private clamp(v: number): number {
    return Math.max(0.0, Math.min(1.0, v));
  }

  async createGoal(
    tenantId: string,
    principalId: string,
    params: { title: string; description: string; motivation: string; priority: number; deadline?: string }
  ): Promise<Goal> {
    const goalId = this.idGenerator.uuid();
    const nowISO = this.clock.nowISO();
    
    // Auto-decompose via LLM (Requirement 44.2)
    const decomposed = await this.llmDecomposer.decomposeGoal(params.title, params.description);
    
    const milestones: Milestone[] = decomposed.map((m, idx) => ({
      milestone_id: this.idGenerator.uuid(),
      goal_id: goalId,
      description: m.description,
      success_criteria: m.success_criteria,
      estimated_hours: m.estimated_hours,
      status: 'pending',
      order: idx,
    }));

    const progress = milestones.length > 0 
      ? milestones.filter(m => m.status === 'completed').length / milestones.length 
      : 0;

    const goal: Goal = {
      goal_id: goalId,
      tenant_id: tenantId,
      principal_id: principalId,
      title: params.title,
      description: params.description,
      motivation: params.motivation,
      priority: this.clamp(params.priority),
      deadline: params.deadline,
      status: 'active',
      progress,
      milestones,
      created_at: nowISO,
      last_progress_at: nowISO,
    };

    await this.store.saveGoal(goal);
    return goal;
  }

  async transitionGoalStatus(tenantId: string, principalId: string, goalId: string, newStatus: GoalStatus): Promise<Goal | undefined> {
    const goal = await this.store.getGoal(goalId);
    if (!goal || goal.tenant_id !== tenantId || goal.principal_id !== principalId) return undefined;

    const oldStatus = goal.status;
    const updated = { ...goal, status: newStatus };
    if (newStatus === 'blocked' && oldStatus !== 'blocked') {
      (updated as any).blocked_since = this.clock.nowISO();
    } else if (newStatus !== 'blocked') {
      delete (updated as any).blocked_since;
    }

    await this.store.saveGoal(updated);

    // Requirement 44.7 (audit on transition)
    await this.auditPublisher.publishAudit({
      type: 'goal_status_transition',
      tenantId,
      principalId,
      goalId,
      oldStatus,
      newStatus,
      timestamp: this.clock.nowISO(),
    });

    return updated;
  }

  async updateMilestoneStatus(tenantId: string, principalId: string, goalId: string, milestoneId: string, status: MilestoneStatus): Promise<Goal | undefined> {
    const goal = await this.store.getGoal(goalId);
    if (!goal || goal.tenant_id !== tenantId || goal.principal_id !== principalId) return undefined;

    const milestones = [...goal.milestones];
    const mIdx = milestones.findIndex(m => m.milestone_id === milestoneId);
    if (mIdx === -1) return undefined;

    const ms = milestones[mIdx]!;
    if (ms.status === status) return goal; // No change

    milestones[mIdx] = {
      ...ms,
      status,
      completed_at: status === 'completed' ? this.clock.nowISO() : ms.completed_at
    };

    // Recalculate progress (Requirement 44.3)
    const completedCount = milestones.filter(m => m.status === 'completed').length;
    const progress = completedCount / milestones.length;

    const isProgressMade = status === 'completed';

    const updated: Goal = {
      ...goal,
      milestones,
      progress,
      last_progress_at: isProgressMade ? this.clock.nowISO() : goal.last_progress_at,
    };

    await this.store.saveGoal(updated);
    return updated;
  }

  async detectBlockers(tenantId: string, principalId: string): Promise<void> {
    const goals = await this.store.getGoals(tenantId, principalId);
    const nowMs = this.clock.nowMs();
    const thresholdMs = this.config.blockedThresholdDays * 24 * 3600 * 1000;

    for (const goal of goals) {
      if (goal.status === 'active') {
        const lastProgressMs = new Date(goal.last_progress_at).getTime();
        if (nowMs - lastProgressMs > thresholdMs) {
          // Flag as blocked
          await this.transitionGoalStatus(tenantId, principalId, goal.goal_id, 'blocked');
        }
      }
    }
  }

  async getNextActions(tenantId: string, principalId: string): Promise<NextActionSuggestion[]> {
    const goals = await this.store.getGoals(tenantId, principalId);
    const nowMs = this.clock.nowMs();
    const actions: NextActionSuggestion[] = [];

    for (const goal of goals) {
      if (goal.status !== 'active') continue;

      const nextPending = goal.milestones.find(m => m.status === 'pending' || m.status === 'in_progress');
      if (nextPending) {
        let deadline_urgency = 0.5; // default
        if (goal.deadline) {
          const deadlineMs = new Date(goal.deadline).getTime();
          const daysRemaining = (deadlineMs - nowMs) / (24 * 3600 * 1000);
          deadline_urgency = this.clamp(1.0 - (daysRemaining / 30)); // 30 days = 0 urgency, 0 days = 1.0 urgency
        }

        const inverse_progress = 1.0 - goal.progress;
        const score = goal.priority * inverse_progress * deadline_urgency;

        actions.push({
          goal_id: goal.goal_id,
          milestone_id: nextPending.milestone_id,
          description: nextPending.description,
          score,
        });
      }
    }

    actions.sort((a, b) => b.score - a.score);
    return actions;
  }
}
