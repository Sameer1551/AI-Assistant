/**
 * Property-Based Tests for Simulation_Service
 *
 * Property 73: Simulation_Result Structure Completeness
 * Property 74: Simulation Abort Recommendation Override
 * Property 75: Simulation Timeout Handling
 *
 * @see Requirements 45.2, 45.5, 45.6
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { SimulationService } from '../src/simulation-service.js';
import type { SimulationRecommendation, RollbackCost } from '@may/types';

describe('Simulation_Service PBT', () => {
  it('Property 73 & 74: Structure Completeness & Abort Override', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          success_prob: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
          confidence: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
          recommendation: fc.constantFrom('proceed' as SimulationRecommendation, 'proceed_with_caution' as SimulationRecommendation, 'abort' as SimulationRecommendation),
          rollback: fc.constantFrom('trivial' as RollbackCost, 'moderate' as RollbackCost, 'high' as RollbackCost, 'irreversible' as RollbackCost),
          override: fc.boolean(),
        }),
        async (params) => {
          const mockPredictor = {
            predict: vi.fn().mockResolvedValue({
              success_probability: params.success_prob,
              confidence: params.confidence,
              recommendation: params.recommendation,
              rollback_cost: params.rollback,
              failure_modes: [ { description: '1', probability: 0.1 }, { description: '2', probability: 0.1 }, { description: '3', probability: 0.1 }, { description: '4', probability: 0.1 } ] // 4 modes to test truncation
            })
          };

          const service = new SimulationService({
            idGenerator: { uuid: () => 'sim-1' },
            clock: { nowISO: () => new Date().toISOString(), nowMs: () => Date.now() },
            auditPublisher: { publishAudit: vi.fn() },
            predictor: mockPredictor,
          });

          const result = await service.simulateAction('act-1', {});

          // Property 73: Structure completeness and bounds
          expect(result.success_probability).toBeCloseTo(params.success_prob);
          expect(result.confidence).toBeCloseTo(params.confidence);
          expect(result.recommendation).toBe(params.recommendation);
          expect(result.rollback_cost).toBe(params.rollback);
          expect(result.failure_modes.length).toBeLessThanOrEqual(3); // Truncated to <=3

          // Property 74: Abort Override
          const canProceed = service.canProceed(result, params.override);
          if (params.recommendation === 'abort') {
            expect(canProceed).toBe(params.override);
          } else {
            expect(canProceed).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 75: Simulation Timeout Handling', async () => {
    const mockPredictor = {
      predict: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 15000))) // Takes 15s, should timeout
    };

    const service = new SimulationService({
      idGenerator: { uuid: () => 'sim-1' },
      clock: { nowISO: () => new Date().toISOString(), nowMs: () => Date.now() },
      auditPublisher: { publishAudit: vi.fn() },
      predictor: mockPredictor,
    });

    const result = await service.simulateAction('act-1', {});

    // Property 75: Timeout fallback
    expect(result.confidence).toBe(0.0);
    expect(result.recommendation).toBe('proceed_with_caution');
  }, 12000); // Test timeout itself needs to be >10s
});
