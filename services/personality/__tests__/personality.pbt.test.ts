/**
 * Property-Based Tests for Personality_Service
 *
 * Property 53: Style_Profile Selection Determinism — exactly one profile selected for any context/state combination
 * Property 54: Style Directive Matches Active Profile — directive consistent with profile parameters
 * Property 55: Personality Drift Detection Threshold — alert and revert on score <0.8
 *
 * @see Requirements 38.3, 38.4, 38.6
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { PersonalityService } from '../src/personality-service.js';

const mockIdGenerator = { uuid: () => 'drift-run-1' };
const mockClock = { nowISO: () => '2026-05-19T12:00:00Z' };

describe('Personality_Service PBT', () => {
  it('Property 53: Style_Profile Selection Determinism', async () => {
    const service = new PersonalityService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      alertEmitter: { emitDriftAlert: vi.fn() },
    });

    await fc.assert(
      fc.property(
        fc.record({
          timeOfDay: fc.integer({ min: 0, max: 23 }),
          focusDepth: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
          stressLevel: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
        }),
        (context) => {
          const profile = service.selectStyleProfile(context);
          
          expect(profile).toBeDefined();
          expect(profile.name).toBeTypeOf('string');
          
          // Test logic matches requirements
          if (context.stressLevel > 0.7) {
            expect(profile.name).toBe('high_stress');
          } else if (context.focusDepth > 0.75) {
            expect(profile.name).toBe('deep_work');
          } else if (context.timeOfDay >= 22 || context.timeOfDay < 5) {
            expect(profile.name).toBe('late_night');
          } else if (context.timeOfDay >= 6 && context.timeOfDay < 9) {
            expect(profile.name).toBe('morning_briefing');
          } else {
            expect(profile.name).toBe('casual_chat');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 54: Style Directive Matches Active Profile', async () => {
    const service = new PersonalityService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      alertEmitter: { emitDriftAlert: vi.fn() },
    });

    await fc.assert(
      fc.property(
        fc.record({
          timeOfDay: fc.integer({ min: 0, max: 23 }),
          focusDepth: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
          stressLevel: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
        }),
        (context) => {
          const profile = service.selectStyleProfile(context);
          const directive = service.generateStyleDirective(profile);
          
          expect(directive).toContain(`[STYLE: ${profile.name.toUpperCase()}]`);
          expect(directive).toContain(`- Verbosity: ${profile.verbosity}`);
          expect(directive).toContain(`- Tone: ${profile.tone}`);
          expect(directive).toContain(`- Formality: ${profile.formality}`);
          expect(directive).toContain(`- Energy: ${profile.energy}`);
          expect(directive).toContain(`- Format Preference: ${profile.format_preference}`);
          expect(directive).toContain(`- Pleasantries: ${profile.pleasantries ? 'Enabled' : 'Disabled'}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 55: Personality Drift Detection Threshold (< 0.8)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -0.5, max: 1.5, noNaN: true }),
        async (score) => {
          const emitDriftAlert = vi.fn().mockResolvedValue(undefined);
          const service = new PersonalityService({
            idGenerator: mockIdGenerator,
            clock: mockClock,
            alertEmitter: { emitDriftAlert },
          });

          const { result, revertToDefault } = await service.checkDrift(score);

          const clampedScore = Math.max(0.0, Math.min(1.0, score));

          if (clampedScore < 0.8) {
            expect(result.drift_detected).toBe(true);
            expect(revertToDefault).toBe(true);
            expect(emitDriftAlert).toHaveBeenCalledTimes(1);
            expect(emitDriftAlert).toHaveBeenCalledWith('drift-run-1', clampedScore, 0.8);
          } else {
            expect(result.drift_detected).toBe(false);
            expect(revertToDefault).toBe(false);
            expect(emitDriftAlert).not.toHaveBeenCalled();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
