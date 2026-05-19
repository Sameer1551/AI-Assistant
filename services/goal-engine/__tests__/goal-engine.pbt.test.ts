/**
 * Property-Based Tests for Goal_Engine_Service
 *
 * Property 70: Goal Progress Ratio — progress = completed_milestones / total_milestones
 * Property 71: Blocked Goal Detection — flagged as blocked after configured days with no progress
 * Property 72: Goal Status Transition Validity — status from valid set, audit event on each transition
 *
 * @see Requirements 44.3, 44.4, 44.7
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { GoalEngineService } from '../src/goal-engine-service.js';
import type { Goal, MilestoneStatus } from '@may/types';

class InMemoryGoalStore {
  public goals = new Map<string, Goal>();
  async saveGoal(goal: Goal) { this.goals.set(goal.goal_id, goal); }
  async getGoal(goalId: string) { return this.goals.get(goalId); }
  async getGoals(tenantId: string, principalId: string) {
    return Array.from(this.goals.values()).filter(g => g.tenant_id === tenantId && g.principal_id === principalId);
  }
}

describe('Goal_Engine_Service PBT', () => {
  it('Property 70 & 72: Progress Ratio & Transition Audit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // initial milestone length
        fc.array(
          fc.record({
            idx: fc.integer({ min: 0, max: 10 }), // max possible index
            status: fc.constantFrom('pending' as MilestoneStatus, 'in_progress' as MilestoneStatus, 'completed' as MilestoneStatus, 'failed' as MilestoneStatus)
          }),
          { minLength: 1, maxLength: 20 }
        ),
        async (numMilestones, actions) => {
          const store = new InMemoryGoalStore();
          let auditCount = 0;
          const mockAudit = {
            publishAudit: vi.fn().mockImplementation(async (e) => {
              if (e.type === 'goal_status_transition') auditCount++;
            })
          };
          
          let msCreated = 0;
          const mockLLM = {
            decomposeGoal: async () => {
              return Array.from({ length: numMilestones }).map((_, i) => ({
                description: `M${i}`,
                success_criteria: `C${i}`,
                estimated_hours: 1
              }));
            }
          };

          const clockMs = 1000000;
          const service = new GoalEngineService({
            idGenerator: { uuid: () => `id-${Math.random()}` },
            clock: { nowISO: () => new Date(clockMs).toISOString(), nowMs: () => clockMs },
            auditPublisher: mockAudit,
            llmDecomposer: mockLLM,
            store,
          });

          const goal = await service.createGoal('t1', 'p1', { title: 'T', description: 'D', motivation: 'M', priority: 0.8 });

          for (const action of actions) {
            const idx = action.idx % goal.milestones.length;
            const ms = goal.milestones[idx]!;
            await service.updateMilestoneStatus('t1', 'p1', goal.goal_id, ms.milestone_id, action.status);
          }

          const updatedGoal = await store.getGoal(goal.goal_id);
          expect(updatedGoal).toBeDefined();
          
          const completedCount = updatedGoal!.milestones.filter(m => m.status === 'completed').length;
          const expectedProgress = numMilestones > 0 ? completedCount / numMilestones : 0;
          
          // Property 70: Progress Ratio
          expect(updatedGoal!.progress).toBeCloseTo(expectedProgress);

          // Test transition
          const oldStatus = updatedGoal!.status;
          await service.transitionGoalStatus('t1', 'p1', goal.goal_id, 'paused');
          const pausedGoal = await store.getGoal(goal.goal_id);
          
          // Property 72: Transition validity & Audit event
          expect(pausedGoal!.status).toBe('paused');
          expect(auditCount).toBeGreaterThanOrEqual(1);
          expect(mockAudit.publishAudit).toHaveBeenCalledWith(expect.objectContaining({
            type: 'goal_status_transition',
            oldStatus,
            newStatus: 'paused'
          }));
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 71: Blocked Goal Detection', async () => {
    const store = new InMemoryGoalStore();
    const mockAudit = { publishAudit: vi.fn() };
    const mockLLM = { decomposeGoal: async () => [] };
    
    // Simulate current time is day 10
    const currentDayMs = 10 * 24 * 3600 * 1000;
    
    const service = new GoalEngineService({
      idGenerator: { uuid: () => `id-${Math.random()}` },
      clock: { nowISO: () => new Date(currentDayMs).toISOString(), nowMs: () => currentDayMs },
      auditPublisher: mockAudit,
      llmDecomposer: mockLLM,
      store,
      config: { blockedThresholdDays: 7 },
    });

    // Directly insert goals into store with different last_progress_at
    await store.saveGoal({
      goal_id: 'g1', tenant_id: 't1', principal_id: 'p1', status: 'active',
      last_progress_at: new Date(1 * 24 * 3600 * 1000).toISOString(), // 9 days ago (> 7) => should block
      title: '', description: '', motivation: '', priority: 0.5, progress: 0, milestones: [], created_at: ''
    } as any);

    await store.saveGoal({
      goal_id: 'g2', tenant_id: 't1', principal_id: 'p1', status: 'active',
      last_progress_at: new Date(5 * 24 * 3600 * 1000).toISOString(), // 5 days ago (< 7) => shouldn't block
      title: '', description: '', motivation: '', priority: 0.5, progress: 0, milestones: [], created_at: ''
    } as any);

    await store.saveGoal({
      goal_id: 'g3', tenant_id: 't1', principal_id: 'p1', status: 'paused',
      last_progress_at: new Date(1 * 24 * 3600 * 1000).toISOString(), // 9 days ago, but paused => shouldn't block
      title: '', description: '', motivation: '', priority: 0.5, progress: 0, milestones: [], created_at: ''
    } as any);

    await service.detectBlockers('t1', 'p1');

    expect((await store.getGoal('g1'))!.status).toBe('blocked');
    expect((await store.getGoal('g2'))!.status).toBe('active');
    expect((await store.getGoal('g3'))!.status).toBe('paused');
  });
});
