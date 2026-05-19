/**
 * Property-Based Tests for Knowledge_Grounding_Service
 *
 * Property 63: Freshness Tier Classification Completeness
 * Property 64: VOLATILE Query Requires Live Web Search (staleness warning in Offline_Mode)
 * Property 65: Web Content Prompt-Injection Defense
 *
 * @see Requirements 41.1, 41.2, 41.6
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { KnowledgeGroundingService } from '../src/knowledge-grounding-service.js';
import type { FreshnessTier, GroundedClaim } from '@may/types';

describe('Knowledge_Grounding_Service PBT', () => {
  it('Property 63, 64, 65: Classification, Web Search requirement, Defense injection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('TIMELESS' as FreshnessTier, 'STABLE' as FreshnessTier, 'VOLATILE' as FreshnessTier),
        fc.double({ min: 0.0, max: 1.0, noNaN: true }),
        fc.boolean(),
        async (tier, confidence, offlineMode) => {
          const mockWebSearch = { search: vi.fn().mockResolvedValue([{ claim: 'raw web content', source: 'live_web', freshness_tier: tier, confidence: 0.9 }]) };
          const mockLocalRag = { search: vi.fn().mockResolvedValue([]) };
          const mockDefense = { sanitize: vi.fn().mockReturnValue('SANITIZED CONTENT') };
          const mockClassifier = {
            classify: vi.fn().mockResolvedValue({ query: 'test', tier, confidence, reasoning: 'test' })
          };

          const service = new KnowledgeGroundingService({
            classifier: mockClassifier,
            webSearch: mockWebSearch,
            localRag: mockLocalRag,
            promptDefense: mockDefense,
          });

          const result = await service.groundQuery('test query', offlineMode);

          // Property 63: Completeness
          expect(result.tier).toBeDefined();
          expect(['TIMELESS', 'STABLE', 'VOLATILE']).toContain(result.tier);

          // Requirements logic for web search
          const needsWeb = tier === 'VOLATILE' || (tier === 'STABLE' && confidence < 0.85);

          if (needsWeb) {
            if (offlineMode) {
              // Property 64: Offline mode warning
              expect(mockWebSearch.search).not.toHaveBeenCalled();
              expect(result.staleness_warning).toBeDefined();
            } else {
              // Property 64: VOLATILE triggers web search
              expect(mockWebSearch.search).toHaveBeenCalledTimes(1);
              expect(result.staleness_warning).toBeUndefined();

              // Property 65: Prompt defense applied
              expect(mockDefense.sanitize).toHaveBeenCalledTimes(1);
              expect(mockDefense.sanitize).toHaveBeenCalledWith('raw web content');
              expect(result.web_results[0]?.claim).toBe('SANITIZED CONTENT');
            }
          } else {
            expect(mockWebSearch.search).not.toHaveBeenCalled();
            expect(result.staleness_warning).toBeUndefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
