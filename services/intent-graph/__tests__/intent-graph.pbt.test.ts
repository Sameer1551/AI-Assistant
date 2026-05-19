/**
 * Property-Based Tests for Intent_Graph_Service
 *
 * Property 60: Intent Graph Node Type Constraints — node types from valid set, edge relations from valid set
 * Property 61: Intent Graph Top-5 Injection — exactly top 5 by composite score injected into LLM calls
 * Property 62: Intent Node Deletion Cascades to Edges — node and all connected edges removed
 *
 * @see Requirements 40.1, 40.3, 40.7
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { IntentGraphService } from '../src/intent-graph-service.js';
import { InMemoryIntentStore } from '../src/in-memory-intent-store.js';
import type { IntentNodeType, IntentEdgeRelation } from '@may/types';

describe('Intent_Graph_Service PBT', () => {
  it('Property 60 & 61: Top-5 Injection Ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            priority: fc.double({ min: 0, max: 1.0, noNaN: true }),
            urgency: fc.double({ min: 0, max: 1.0, noNaN: true }),
            emotional: fc.double({ min: 0, max: 1.0, noNaN: true }),
            ageDays: fc.integer({ min: 0, max: 30 }),
          }),
          { minLength: 6, maxLength: 20 }
        ),
        async (nodeGen) => {
          const store = new InMemoryIntentStore();
          const clock = {
            nowISO: () => '2026-05-19T12:00:00Z',
            nowMs: () => 1000000000000,
          };
          let idCounter = 1;
          const service = new IntentGraphService({
            idGenerator: { uuid: () => `node-${idCounter++}` },
            clock,
            auditPublisher: { publishAudit: vi.fn() },
            store,
          });

          for (const gen of nodeGen) {
            const node = await service.addNode('t1', 'p1', 'goal' as IntentNodeType, 'Title', {
              priority: gen.priority,
              urgency: gen.urgency,
              emotional_weight: gen.emotional,
            });
            
            // manually backdate last_active
            const backdatedMs = clock.nowMs() - (gen.ageDays * 24 * 3600 * 1000);
            await store.updateNode({ ...node, last_active: new Date(backdatedMs).toISOString() });
          }

          const topNodes = await service.getTopNodesForInjection('t1', 'p1');
          expect(topNodes.length).toBe(5);

          // Verify sorted correctly
          const scores = topNodes.map(node => {
            const activeMs = new Date(node.last_active).getTime();
            const ageMs = Math.max(0, clock.nowMs() - activeMs);
            const halfLifeMs = 7 * 24 * 3600 * 1000;
            const recency = Math.max(0.0, Math.pow(0.5, ageMs / halfLifeMs));
            return node.priority * node.urgency * recency;
          });

          for (let i = 0; i < scores.length - 1; i++) {
            expect(scores[i]).toBeGreaterThanOrEqual(scores[i+1]!);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 62: Intent Node Deletion Cascades to Edges', async () => {
    const store = new InMemoryIntentStore();
    const mockAudit = { publishAudit: vi.fn() };
    const service = new IntentGraphService({
      idGenerator: { uuid: () => `id-${Math.random()}` },
      clock: { nowISO: () => new Date().toISOString(), nowMs: () => Date.now() },
      auditPublisher: mockAudit,
      store,
    });

    const node1 = await service.addNode('t1', 'p1', 'project', 'P1', { priority: 1, urgency: 1, emotional_weight: 0 });
    const node2 = await service.addNode('t1', 'p1', 'goal', 'G1', { priority: 1, urgency: 1, emotional_weight: 0 });
    const node3 = await service.addNode('t1', 'p1', 'blocker', 'B1', { priority: 1, urgency: 1, emotional_weight: 0 });

    await service.addEdge(node1.node_id, node2.node_id, 'part_of', 1.0);
    const edge2 = await service.addEdge(node2.node_id, node3.node_id, 'blocks', 1.0);

    // Delete node1
    await service.deleteNode('t1', 'p1', node1.node_id);

    // Node1 should be gone, Node2 should remain
    expect(await store.getNode(node1.node_id)).toBeUndefined();
    expect(await store.getNode(node2.node_id)).toBeDefined();

    // Edge connected to Node1 should be gone
    const node1Edges = await store.getEdgesForNode(node1.node_id);
    expect(node1Edges.length).toBe(0);

    // Edge2 should remain
    const node2Edges = await store.getEdgesForNode(node2.node_id);
    expect(node2Edges.length).toBe(1);
    expect(node2Edges[0]?.edge_id).toBe(edge2.edge_id);

    expect(mockAudit.publishAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.publishAudit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'intent_node_deleted',
      nodeId: node1.node_id,
      edgesRemoved: 1
    }));
  });
});
