/**
 * Property-Based Tests for Cognitive_State_Service
 *
 * Property 51: Cognitive_State Vector Valid Ranges — all 7 fields in [0.0, 1.0]
 * Property 52: Cognitive State Directive Adaptation — extremely brief when focus_depth >0.75, calm/solution-first when frustration >0.7
 *
 * @see Requirements 37.1, 37.5
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { CognitiveStateService } from '../src/cognitive-state-service.js';
import type { ObservableSignals } from '../src/interfaces/index.js';

const mockIdGenerator = { uuid: () => 'state-123' };
const mockClock = { nowISO: () => '2026-05-19T12:00:00Z' };

describe('Cognitive_State_Service PBT', () => {
  it('Property 51: Cognitive_State Vector Valid Ranges (all 7 fields in [0.0, 1.0])', async () => {
    const mockPublisher = { publishInterruptionTolerance: vi.fn() };
    const service = new CognitiveStateService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      proactivePublisher: mockPublisher,
    });

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          keystrokeVelocity: fc.double({ min: 0, max: 1000, noNaN: true }),
          appSwitchCount: fc.integer({ min: 0, max: 100 }),
          errorFrequency: fc.integer({ min: 0, max: 50 }),
          sessionDurationMinutes: fc.double({ min: 0, max: 600, noNaN: true }),
          minutesToNextMeeting: fc.double({ min: 0, max: 240, noNaN: true }),
        }),
        fc.boolean(),
        async (signals, featureEnabled) => {
          const { state } = await service.processSignals('t1', 'p1', signals, featureEnabled);

          expect(state.focus_depth).toBeGreaterThanOrEqual(0.0);
          expect(state.focus_depth).toBeLessThanOrEqual(1.0);

          expect(state.interruption_tolerance).toBeGreaterThanOrEqual(0.0);
          expect(state.interruption_tolerance).toBeLessThanOrEqual(1.0);

          expect(state.fatigue_score).toBeGreaterThanOrEqual(0.0);
          expect(state.fatigue_score).toBeLessThanOrEqual(1.0);

          expect(state.task_switch_cost).toBeGreaterThanOrEqual(0.0);
          expect(state.task_switch_cost).toBeLessThanOrEqual(1.0);

          expect(state.cognitive_load).toBeGreaterThanOrEqual(0.0);
          expect(state.cognitive_load).toBeLessThanOrEqual(1.0);

          expect(state.urgency_pressure).toBeGreaterThanOrEqual(0.0);
          expect(state.urgency_pressure).toBeLessThanOrEqual(1.0);

          expect(state.frustration_probability).toBeGreaterThanOrEqual(0.0);
          expect(state.frustration_probability).toBeLessThanOrEqual(1.0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 52: Cognitive State Directive Adaptation', async () => {
    const mockPublisher = { publishInterruptionTolerance: vi.fn() };
    const service = new CognitiveStateService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      proactivePublisher: mockPublisher,
    });

    // Test deep focus
    const deepFocusSignals: ObservableSignals = {
      keystrokeVelocity: 400, // >300
      appSwitchCount: 0,
      errorFrequency: 0,
      sessionDurationMinutes: 10,
      minutesToNextMeeting: 60,
    };

    const result1 = await service.processSignals('t1', 'p1', deepFocusSignals, true);
    expect(result1.state.focus_depth).toBeGreaterThan(0.75);
    expect(result1.directive.response_style).toBe('extremely_brief');
    expect(result1.directive.directive_text).toContain('extreme brevity');

    // Test high frustration
    const highFrustrationSignals: ObservableSignals = {
      keystrokeVelocity: 50,
      appSwitchCount: 10,
      errorFrequency: 25, // >20
      sessionDurationMinutes: 60,
      minutesToNextMeeting: 60,
    };

    const result2 = await service.processSignals('t1', 'p1', highFrustrationSignals, true);
    // focus_depth will be low due to high app switching and low keystroke
    expect(result2.state.frustration_probability).toBeGreaterThan(0.7);
    expect(result2.directive.tone).toBe('calm');
    expect(result2.directive.directive_text).toContain('calm');
    expect(result2.directive.directive_text).toContain('solution-oriented');

    // Test feature disabled
    const result3 = await service.processSignals('t1', 'p1', deepFocusSignals, false);
    expect(result3.state.focus_depth).toBe(0.5);
    expect(result3.state.frustration_probability).toBe(0.5);
    expect(result3.directive.response_style).toBe('normal');
  });
});
