/**
 * Property-Based Tests for Research_Service
 *
 * Property 91: Research Experiment No Direct Deployment
 *
 * @see Requirements 51.4, 51.7
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { ResearchService } from '../src/research-service.js';
import type { ThrottleLevel } from '@may/types';

describe('Research_Service PBT', () => {
  it('Property 91: Research Experiment No Direct Deployment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('NORMAL', 'REDUCED', 'MINIMAL', 'EMERGENCY') as fc.Arbitrary<ThrottleLevel>,
        fc.boolean(), // user active
        fc.double({ min: 0.1, max: 0.9, noNaN: true }), // baseline score
        fc.double({ min: 0.1, max: 0.9, noNaN: true }), // experimental score
        async (throttle, userActive, baselineScore, experimentalScore) => {
          const mockSelfImprovement = { proposeImprovement: vi.fn() };
          const mockAudit = { publishAudit: vi.fn() };

          const service = new ResearchService({
            idGenerator: { uuid: () => 'id' },
            clock: { nowISO: () => 'time', nowMs: () => 1 },
            auditPublisher: mockAudit,
            resourceGovernor: { getCurrentThrottleLevel: async () => throttle, isUserActive: async () => userActive },
            selfImprovementPublisher: mockSelfImprovement,
            evalService: { getBaselineScore: async () => baselineScore, runExperiment: async () => ({ score: experimentalScore }) },
          });

          const result = await service.runExperiment('t1', 'hypo');

          if (throttle !== 'NORMAL' || userActive) {
            expect(result).toBeNull();
            expect(mockSelfImprovement.proposeImprovement).not.toHaveBeenCalled();
          } else {
            expect(result).not.toBeNull();
            if (experimentalScore > baselineScore) {
              expect(result!.positive_result).toBe(true);
              // Property 91: Positive results fed to self improvement publisher (not deployed directly by research service)
              expect(mockSelfImprovement.proposeImprovement).toHaveBeenCalledWith('hypo', expect.any(String));
            } else {
              expect(result!.positive_result).toBe(false);
              expect(mockSelfImprovement.proposeImprovement).not.toHaveBeenCalled();
            }
            expect(mockAudit.publishAudit).toHaveBeenCalled();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
