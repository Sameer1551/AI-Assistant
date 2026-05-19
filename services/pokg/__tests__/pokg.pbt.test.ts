/**
 * Property-Based Tests for POKG_Service
 *
 * Property 66: POKG Workflow Type Identification
 *
 * @see Requirements 42.3
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { POKGService } from '../src/pokg-service.js';
import type { WorkflowPattern, POKGStore } from '../src/pokg-service.js';

class InMemoryPOKGStore implements POKGStore {
  private patterns: WorkflowPattern[] = [];

  async savePattern(pattern: WorkflowPattern): Promise<void> {
    this.patterns.push(pattern);
  }

  async getPatterns(tenantId: string, principalId: string): Promise<WorkflowPattern[]> {
    return this.patterns.filter(p => p.tenantId === tenantId && p.principalId === principalId);
  }

  async deletePattern(tenantId: string, principalId: string, patternId: string): Promise<void> {
    this.patterns = this.patterns.filter(p => p.id !== patternId);
  }
}

describe('POKG_Service PBT', () => {
  it('Property 66: Workflow Type Identification', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 3 }), { minLength: 1, maxLength: 5 }), // Apps
        async (apps) => {
          const store = new InMemoryPOKGStore();
          const service = new POKGService(store);

          await service.addLearnedPattern({
            id: 'pattern-1',
            tenantId: 't1',
            principalId: 'p1',
            label: 'coding',
            requiredApps: apps,
            confidence: 0.9,
          });

          // Exact match
          const match1 = await service.identifyWorkflow('t1', 'p1', apps);
          expect(match1.label).toBe('coding');
          expect(match1.confidence).toBe(0.9);

          // Subsets shouldn't match (unless they are all exactly met)
          if (apps.length > 1) {
            const subset = apps.slice(0, apps.length - 1);
            const match2 = await service.identifyWorkflow('t1', 'p1', subset);
            expect(match2.label).toBe('unknown');
            expect(match2.confidence).toBe(0.0);
          }

          // Superset should match
          const superset = [...apps, 'Spotify'];
          const match3 = await service.identifyWorkflow('t1', 'p1', superset);
          expect(match3.label).toBe('coding');
          expect(match3.confidence).toBe(0.9);

          // Wrong principal
          const match4 = await service.identifyWorkflow('t1', 'p2', apps);
          expect(match4.label).toBe('unknown');
          expect(match4.confidence).toBe(0.0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
