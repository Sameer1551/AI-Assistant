/**
 * Property-Based Tests for Fine_Tuning_Service
 *
 * Property 87: Fine-Tuning Local-Only Constraint
 * Property 88: Fine-Tuning Review Gate
 * Property 89: LoRA-Only Constraint
 * Property 90: Throttle_Level Gating
 *
 * @see Requirements 50.1, 50.2, 50.3, 50.6
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { FineTuningService } from '../src/fine-tuning-service.js';
import type { ThrottleLevel } from '@may/types';

describe('Fine_Tuning_Service PBT', () => {
  it('Property 88, 89, 90: Review Gate, LoRA only, Throttle Gating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('NORMAL', 'REDUCED', 'MINIMAL', 'EMERGENCY') as fc.Arbitrary<ThrottleLevel>,
        fc.boolean(), // Tenant enabled
        fc.array(fc.record({ id: fc.string() }), { minLength: 0, maxLength: 5 }), // Approved data
        fc.double({ min: 0.1, max: 0.9, noNaN: true }), // baseline score
        fc.double({ min: 0.1, max: 0.9, noNaN: true }), // adapter score
        async (throttle, tenantEnabled, pendingData, baselineScore, adapterScore) => {
          const mockStore = {
            getTenantConfig: async () => ({ fineTuningEnabled: tenantEnabled }),
            saveAdapter: vi.fn(),
            getPendingTrainingData: async () => pendingData,
            markTrainingDataReviewed: vi.fn(),
            getAdapterVersions: async () => [],
          };
          
          const mockTrainer = {
            train: vi.fn().mockResolvedValue({ adapterId: 'ad-1', version: 1 })
          };

          const service = new FineTuningService({
            idGenerator: { uuid: () => 'id' },
            clock: { nowISO: () => 'time', nowMs: () => 1 },
            auditPublisher: { publishAudit: vi.fn() },
            benchmarkEngine: { evaluateBaseline: async () => baselineScore, evaluateWithAdapter: async () => adapterScore },
            resourceGovernor: { getCurrentThrottleLevel: async () => throttle },
            store: mockStore,
            trainer: mockTrainer,
          });

          const result = await service.runFineTuning('t1', 'base-model');

          if (throttle !== 'NORMAL') {
            // Property 90: Throttle Level Gating
            expect(result).toBeNull();
            expect(mockTrainer.train).not.toHaveBeenCalled();
          } else if (!tenantEnabled) {
            expect(result).toBeNull();
            expect(mockTrainer.train).not.toHaveBeenCalled();
          } else if (pendingData.length === 0) {
            // Property 88: Review Gate (must have approved data)
            expect(result).toBeNull();
            expect(mockTrainer.train).not.toHaveBeenCalled();
          } else {
            // Valid run
            expect(result).not.toBeNull();
            expect(mockTrainer.train).toHaveBeenCalledWith(pendingData, 'base-model'); // Property 88
            
            // Property 89: LoRA only (result is an adapter, not base model)
            expect(result!.base_model_id).toBe('base-model');
            expect(result!.adapter_id).toBe('ad-1');

            if (adapterScore < baselineScore) {
              expect(result!.rolled_back).toBe(true);
              expect(result!.is_active).toBe(false);
            } else {
              expect(result!.rolled_back).toBe(false);
              expect(result!.is_active).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
