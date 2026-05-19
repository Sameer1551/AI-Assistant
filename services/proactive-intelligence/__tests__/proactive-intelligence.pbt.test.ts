/**
 * Property-Based Tests for Proactive_Intelligence_Service
 *
 * Property 56: Interrupt Budget Enforcement — max configured signals per hour unless urgency >0.9
 * Property 57: Deep Focus Suppression — suppress during deep focus unless urgency >0.9
 * Property 58: Proactive Signal Score Computation — score = urgency × relevance × recency_factor, deliver only above threshold
 * Property 59: Dismissal Threshold Adjustment — threshold increases by 0.1 after 3 consecutive dismissals
 *
 * @see Requirements 39.1, 39.2, 39.3, 39.7
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { ProactiveIntelligenceService } from '../src/proactive-intelligence-service.js';

const mockIdGenerator = { uuid: () => 'sig-1' };
let currentTime = 1000000;
const mockClock = { 
  nowISO: () => new Date(currentTime).toISOString(),
  nowMs: () => currentTime,
};

describe('Proactive_Intelligence_Service PBT', () => {
  it('Property 56 & 57 & 58: Budget Enforcement, Focus Suppression, Score Computation', async () => {
    const mockAudit = { publishAudit: vi.fn() };
    const service = new ProactiveIntelligenceService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      auditPublisher: mockAudit,
      config: { maxPerHour: 2, baseThreshold: 0.65 },
    });

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          urgency: fc.double({ min: 0, max: 1.0, noNaN: true }),
          relevance: fc.double({ min: 0, max: 1.0, noNaN: true }),
          recency_factor: fc.double({ min: 0, max: 1.0, noNaN: true }),
        }),
        fc.record({
          focusDepth: fc.double({ min: 0, max: 1.0, noNaN: true }),
          lastKeystrokeMinutesAgo: fc.double({ min: 0, max: 60, noNaN: true }),
        }),
        fc.integer({ min: 0, max: 5 }), // Number of prior deliveries this hour
        async (signalGen, context, priorDeliveries) => {
          // Reset state for isolation
          const localService = new ProactiveIntelligenceService({
            idGenerator: mockIdGenerator,
            clock: mockClock,
            auditPublisher: mockAudit,
            config: { maxPerHour: 2, baseThreshold: 0.65 },
          });

          // Hack to setup prior deliveries
          for (let i = 0; i < priorDeliveries; i++) {
            await localService.evaluateSignal('t1', 'p1', { focusDepth: 0, lastKeystrokeMinutesAgo: 10 }, {
              source: 'test', urgency: 0.99, relevance: 1, recency_factor: 1, content: 'prior'
            });
          }

          const { decision, signal } = await localService.evaluateSignal('t1', 'p1', context, {
            source: 'test',
            urgency: signalGen.urgency,
            relevance: signalGen.relevance,
            recency_factor: signalGen.recency_factor,
            content: 'test',
          });

          // Prop 58: Score Computation
          expect(signal.computed_score).toBeCloseTo(signalGen.urgency * signalGen.relevance * signalGen.recency_factor);

          const isDeepFocus = context.focusDepth > 0.75 && context.lastKeystrokeMinutesAgo < 5;
          const budgetExceeded = priorDeliveries >= 2;
          const overrideUrgency = signalGen.urgency > 0.9;
          
          if (signal.computed_score < 0.65) {
            expect(decision.decision).toBe('suppressed');
            expect(decision.reason).toBe('below_threshold');
          } else if (isDeepFocus && !overrideUrgency) {
            // Prop 57: Deep Focus Suppression
            expect(decision.decision).toBe('suppressed');
            expect(decision.reason).toBe('deep_focus');
          } else if (budgetExceeded && !overrideUrgency) {
            // Prop 56: Interrupt Budget Enforcement
            expect(decision.decision).toBe('suppressed');
            expect(decision.reason).toBe('budget_exceeded');
          } else {
            expect(decision.decision).toBe('delivered');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 59: Dismissal Threshold Adjustment', async () => {
    const mockAudit = { publishAudit: vi.fn() };
    const service = new ProactiveIntelligenceService({
      idGenerator: mockIdGenerator,
      clock: mockClock,
      auditPublisher: mockAudit,
      config: { baseThreshold: 0.5 },
    });

    let status = service.getBudgetStatus('p1');
    expect(status.score_threshold).toBeCloseTo(0.5);

    // 1 dismissal -> threshold = 0.5
    await service.handleDismissal('p1');
    status = service.getBudgetStatus('p1');
    expect(status.score_threshold).toBeCloseTo(0.5);

    // 2 dismissals -> threshold = 0.5
    await service.handleDismissal('p1');
    status = service.getBudgetStatus('p1');
    expect(status.score_threshold).toBeCloseTo(0.5);

    // 3 dismissals -> threshold = 0.6 (increase by 0.1)
    await service.handleDismissal('p1');
    status = service.getBudgetStatus('p1');
    expect(status.score_threshold).toBeCloseTo(0.6);

    // 6 dismissals -> threshold = 0.7
    await service.handleDismissal('p1');
    await service.handleDismissal('p1');
    await service.handleDismissal('p1');
    status = service.getBudgetStatus('p1');
    expect(status.score_threshold).toBeCloseTo(0.7);

    // Engagement resets dismissals -> threshold = 0.5
    await service.handleEngagement('p1');
    status = service.getBudgetStatus('p1');
    expect(status.score_threshold).toBeCloseTo(0.5);
  });
});
