/**
 * Property-Based Tests for Reflection_Service
 *
 * Property 76: Reflection Record Completeness
 *
 * @see Requirements 46.2
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { ReflectionService } from '../src/reflection-service.js';
import type { UserSignal, ReflectionRecord } from '@may/types';

describe('Reflection_Service PBT', () => {
  it('Property 76: Reflection Record Completeness', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          usefulnessScore: fc.double({ min: -1.0, max: 2.0, noNaN: true }), // Intentional out of bounds to test clamping
          predictionAccuracy: fc.double({ min: -1.0, max: 2.0, noNaN: true }),
          userSignal: fc.constantFrom('accepted' as UserSignal, 'rejected' as UserSignal, 'modified' as UserSignal, 'ignored' as UserSignal),
          hasSimId: fc.boolean(),
        }),
        async (params) => {
          const records: ReflectionRecord[] = [];
          const service = new ReflectionService({
            idGenerator: { uuid: () => 'ref-1' },
            clock: { nowISO: () => '2026-05-19T12:00:00Z', nowMs: () => 1000000000000 },
            auditPublisher: { publishAudit: vi.fn() },
            selfImprovementPublisher: { publishLesson: vi.fn() },
            store: {
              saveReflection: async (r) => { records.push(r); },
              getReflections: async () => records,
            },
          });

          const record = await service.reflectOnAction('t1', 'p1', {
            actionId: 'act-1',
            actionDescription: 'desc',
            intendedOutcome: 'int',
            actualOutcome: 'act',
            userSignal: params.userSignal,
            usefulnessScore: params.usefulnessScore,
            lesson: 'lesson',
            simulationResultId: params.hasSimId ? 'sim-1' : undefined,
            predictionAccuracy: params.predictionAccuracy,
          });

          expect(record.reflection_id).toBeDefined();
          expect(record.tenant_id).toBe('t1');
          expect(record.principal_id).toBe('p1');
          expect(record.usefulness_score).toBeGreaterThanOrEqual(0.0);
          expect(record.usefulness_score).toBeLessThanOrEqual(1.0);
          expect(record.prediction_accuracy).toBeGreaterThanOrEqual(0.0);
          expect(record.prediction_accuracy).toBeLessThanOrEqual(1.0);
          expect(record.expires_at).toBeDefined();

          if (params.hasSimId) {
            expect(record.simulation_result_id).toBe('sim-1');
          } else {
            expect(record.simulation_result_id).toBeUndefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
