/**
 * Property-Based Tests for Self_Improvement_Service
 *
 * Property 84: Benchmark-Gated Deployment
 * Property 85: Version Retention
 * Property 86: Minimum Corrections Before Improvement Cycle
 *
 * @see Requirements 49.2, 49.3, 49.6, 49.7
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { SelfImprovementService } from '../src/self-improvement-service.js';
import type { PromptVersion } from '@may/types';

describe('Self_Improvement_Service PBT', () => {
  it('Property 84, 86: Minimum Corrections & Benchmark-Gated Deployment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // Number of corrections
        fc.double({ min: 0.1, max: 0.9, noNaN: true }), // Current baseline score
        fc.double({ min: 0.1, max: 0.9, noNaN: true }), // Candidate score
        async (numCorrections, baselineScore, candidateScore) => {
          let activePrompt: PromptVersion | undefined = {
            version_id: 'v1', prompt_content: 'old', benchmark_score: baselineScore,
            created_at: '', is_active: true
          };
          const mockStore = {
            saveCycle: vi.fn(),
            savePromptVersion: vi.fn(),
            getActivePrompt: async () => activePrompt,
            getRecentPrompts: async () => [activePrompt!],
            getCorrectionsCount: async () => numCorrections,
            clearCorrections: vi.fn(),
          };

          const service = new SelfImprovementService({
            idGenerator: { uuid: () => 'id' },
            clock: { nowISO: () => 'time', nowMs: () => 1 },
            auditPublisher: { publishAudit: vi.fn() },
            telemetryPublisher: { publishTelemetry: vi.fn() },
            benchmarkEngine: { evaluate: async (p) => p === 'old' ? baselineScore : candidateScore },
            store: mockStore,
          });

          const cycle = await service.runImprovementCycle('new');

          if (numCorrections < 10) {
            // Property 86: Minimum corrections
            expect(cycle).toBeNull();
            expect(mockStore.saveCycle).not.toHaveBeenCalled();
          } else {
            expect(cycle).not.toBeNull();
            // Property 84: Benchmark-Gated Deployment
            if (candidateScore >= baselineScore) {
              expect(cycle!.decision).toBe('promoted');
              expect(mockStore.savePromptVersion).toHaveBeenCalledTimes(2); // One to deactivate old, one to add new
            } else {
              expect(cycle!.decision).toBe('discarded');
              expect(mockStore.savePromptVersion).not.toHaveBeenCalled(); // No prompt changes
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 84: Auto-rollback on score drop', async () => {
    // Current baseline evaluate() returns much lower than recorded score
    let activePrompt: PromptVersion | undefined = {
      version_id: 'v2', prompt_content: 'bad', benchmark_score: 0.8, // Recorded 0.8
      created_at: '', is_active: true
    };
    let previousPrompt: PromptVersion = {
      version_id: 'v1', prompt_content: 'good', benchmark_score: 0.75,
      created_at: '', is_active: false
    };

    const mockStore = {
      saveCycle: vi.fn(),
      savePromptVersion: vi.fn(),
      getActivePrompt: async () => activePrompt,
      getRecentPrompts: async () => [previousPrompt, activePrompt!],
      getCorrectionsCount: async () => 15,
      clearCorrections: vi.fn(),
    };
    const mockAudit = { publishAudit: vi.fn() };

    const service = new SelfImprovementService({
      idGenerator: { uuid: () => 'id' },
      clock: { nowISO: () => 'time', nowMs: () => 1 },
      auditPublisher: mockAudit,
      telemetryPublisher: { publishTelemetry: vi.fn() },
      benchmarkEngine: { evaluate: async (p) => p === 'bad' ? 0.7 : 0.9 }, // Degraded to 0.7 (drop > 0.05)
      store: mockStore,
    });

    const cycle = await service.runImprovementCycle('new');
    
    // Cycle should be interrupted by rollback
    expect(cycle).toBeNull();
    expect(mockStore.savePromptVersion).toHaveBeenCalledWith(expect.objectContaining({ version_id: 'v2', is_active: false }));
    expect(mockStore.savePromptVersion).toHaveBeenCalledWith(expect.objectContaining({ version_id: 'v1', is_active: true }));
    expect(mockAudit.publishAudit).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt_rollback' }));
  });
});
