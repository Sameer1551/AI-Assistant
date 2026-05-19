/**
 * Property-Based Tests for Planning_Service
 *
 * Property 77: Dependency Cycle Detection and Rejection
 * Property 78: Plan Execution Respects Dependencies
 * Property 79: Subtree Replanning on Failure
 *
 * @see Requirements 47.3, 47.4, 47.5
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { PlanningService } from '../src/planning-service.js';
import type { PlanTree, PlanNode } from '@may/types';

describe('Planning_Service PBT', () => {
  it('Property 77: Dependency Cycle Detection and Rejection', async () => {
    const service = new PlanningService({
      idGenerator: { uuid: () => 'id' },
      clock: { nowISO: () => 'time', nowMs: () => 1 },
      auditPublisher: { publishAudit: vi.fn() },
      store: { savePlan: vi.fn(), getPlan: vi.fn() },
    });

    const cyclicNodes: PlanNode[] = [
      { node_id: 'n1', dependencies: ['n2'], children: [], level: 'operational', description: '', status: 'pending', timeout_seconds: 1, plan_id: 'p1' },
      { node_id: 'n2', dependencies: ['n3'], children: [], level: 'operational', description: '', status: 'pending', timeout_seconds: 1, plan_id: 'p1' },
      { node_id: 'n3', dependencies: ['n1'], children: [], level: 'operational', description: '', status: 'pending', timeout_seconds: 1, plan_id: 'p1' },
    ];

    await expect(service.createPlan('t1', 'p1', 'goal', 100, cyclicNodes))
      .rejects.toThrow('Dependency cycle detected');
  });

  it('Property 78: Plan Execution Respects Dependencies', async () => {
    const service = new PlanningService({
      idGenerator: { uuid: () => 'id' },
      clock: { nowISO: () => 'time', nowMs: () => 1 },
      auditPublisher: { publishAudit: vi.fn() },
      store: { savePlan: vi.fn(), getPlan: vi.fn() },
    });

    const nodes: PlanNode[] = [
      { node_id: 'n1', dependencies: [], children: [], level: 'operational', description: '', status: 'pending', timeout_seconds: 1, plan_id: 'p1' },
      { node_id: 'n2', dependencies: ['n1'], children: [], level: 'operational', description: '', status: 'pending', timeout_seconds: 1, plan_id: 'p1' },
    ];

    const plan: PlanTree = {
      plan_id: 'p1', tenant_id: 't1', principal_id: 'p1', root_goal: 'g', created_at: '', status: 'pending', timeout_seconds: 1,
      nodes,
    };

    let exec = service.getExecutableNodes(plan);
    expect(exec.length).toBe(1);
    expect(exec[0]!.node_id).toBe('n1'); // n2 cannot start because n1 is pending

    // Mock n1 done
    plan.nodes[0] = { ...plan.nodes[0]!, status: 'done' };
    exec = service.getExecutableNodes(plan);
    expect(exec.length).toBe(1);
    expect(exec[0]!.node_id).toBe('n2'); // n2 can now start
  });

  it('Property 79: Subtree Replanning on Failure', async () => {
    let savedPlan: PlanTree | undefined;
    const store = {
      savePlan: async (p: PlanTree) => { savedPlan = p; },
      getPlan: async () => savedPlan,
    };

    const service = new PlanningService({
      idGenerator: { uuid: () => 'id' },
      clock: { nowISO: () => 'time', nowMs: () => 1 },
      auditPublisher: { publishAudit: vi.fn() },
      store,
    });

    const nodes: PlanNode[] = [
      { node_id: 'n1', dependencies: [], children: ['n2', 'n3'], level: 'strategic', description: '', status: 'running', timeout_seconds: 1, plan_id: 'p1' },
      { node_id: 'n2', dependencies: [], children: [], level: 'operational', description: 'failed_node', status: 'failed', timeout_seconds: 1, plan_id: 'p1', parent_node_id: 'n1' },
      { node_id: 'n3', dependencies: [], children: [], level: 'operational', description: 'healthy_node', status: 'done', timeout_seconds: 1, plan_id: 'p1', parent_node_id: 'n1' },
    ];

    await service.createPlan('t1', 'p1', 'goal', 100, nodes);

    const newNodes: PlanNode[] = [
      { node_id: 'n4', dependencies: [], children: [], level: 'operational', description: 'replacement', status: 'pending', timeout_seconds: 1, plan_id: 'p1', parent_node_id: 'n1' },
    ];

    const newPlan = await service.replanSubtree('p1', 'n2', newNodes);
    
    // n2 was replaced, n3 remains, n4 added
    expect(newPlan.nodes.map(n => n.node_id)).toContain('n1');
    expect(newPlan.nodes.map(n => n.node_id)).toContain('n3');
    expect(newPlan.nodes.map(n => n.node_id)).toContain('n4');
    expect(newPlan.nodes.map(n => n.node_id)).not.toContain('n2');
  });
});
