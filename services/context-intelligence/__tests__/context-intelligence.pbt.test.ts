/**
 * Property-Based Tests for Context_Intelligence_Service
 *
 * Property 49: Context_Packet Field Completeness — every field has confidence score in [0,1], fields <0.7 annotated with uncertainty
 * Property 50: Context Provider Timeout Fallback — on timeout, use cached value, reduce confidence by exactly 0.2 (clamped to 0.0)
 *
 * @see Requirements 36.3, 36.4, 36.7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ContextIntelligenceService } from '../src/context-intelligence-service.js';
import type { IContextProvider } from '../src/interfaces/index.js';

const mockIdGenerator = { uuid: () => 'test-packet-id' };
const mockClock = { nowISO: () => '2026-05-19T12:00:00Z' };

describe('Context_Intelligence_Service PBT', () => {
  it('Property 49: Context_Packet Field Completeness (confidence bounds and uncertainty annotation)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.string({ minLength: 1 }),
          fc.record({
            value: fc.anything(),
            confidence: fc.double({ min: -1.0, max: 2.0, noNaN: true }),
          })
        ),
        async (mockData) => {
          const service = new ContextIntelligenceService({
            idGenerator: mockIdGenerator,
            clock: mockClock,
          });

          const provider: IContextProvider = {
            providerId: 'provider-1',
            fields: Object.keys(mockData),
            async fetchContext() {
              return mockData;
            },
          };

          service.registerProvider(provider);

          const packet = await service.assembleContext('t1', 'p1');

          for (const field of packet.fields) {
            // Field completeness
            expect(field.confidence_score).toBeGreaterThanOrEqual(0.0);
            expect(field.confidence_score).toBeLessThanOrEqual(1.0);

            // Uncertainty annotation check
            if (field.confidence_score < 0.7) {
              expect(field.uncertainty_annotation).toBeDefined();
              expect(field.uncertainty_annotation).toContain('Uncertain');
            } else {
              expect(field.uncertainty_annotation).toBeUndefined();
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 50: Context Provider Timeout Fallback', async () => {
    // We'll test with a single field to observe the decay sequence
    const service = new ContextIntelligenceService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      providerTimeoutMs: 10, // Short timeout for testing
    });

    let fetchShouldTimeout = false;
    const provider: IContextProvider = {
      providerId: 'timeout-provider',
      fields: ['active_file'],
      async fetchContext() {
        if (fetchShouldTimeout) {
          // Block longer than timeout
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {};
        }
        return {
          active_file: { value: 'test.ts', confidence: 0.8 },
        };
      }
    };
    service.registerProvider(provider);

    // Initial success fetch -> confidence 0.8
    const packet1 = await service.assembleContext('t1', 'p1');
    expect(packet1.fields[0]!.confidence_score).toBeCloseTo(0.8);
    expect(packet1.fields[0]!.is_cached).toBe(false);

    // First timeout -> confidence should drop by 0.2 down to 0.6
    fetchShouldTimeout = true;
    const packet2 = await service.assembleContext('t1', 'p1');
    expect(packet2.fields[0]!.confidence_score).toBeCloseTo(0.6);
    expect(packet2.fields[0]!.is_cached).toBe(true);
    expect(packet2.fields[0]!.value).toBe('test.ts');
    expect(packet2.fields[0]!.uncertainty_annotation).toBeDefined(); // < 0.7 now

    // Second timeout -> confidence drops to 0.4
    const packet3 = await service.assembleContext('t1', 'p1');
    expect(packet3.fields[0]!.confidence_score).toBeCloseTo(0.4);
    expect(packet3.fields[0]!.is_cached).toBe(true);

    // Fetch times out until confidence hits 0.0
    await service.assembleContext('t1', 'p1'); // 0.2
    const packet5 = await service.assembleContext('t1', 'p1'); // 0.0
    expect(packet5.fields[0]!.confidence_score).toBeCloseTo(0.0);

    // One more to ensure it clamps at 0.0
    const packet6 = await service.assembleContext('t1', 'p1');
    expect(packet6.fields[0]!.confidence_score).toBeCloseTo(0.0);
  });
});
