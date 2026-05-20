import { describe, it, expect, vi } from 'vitest';
import { HudClientService } from '../src/hud-client-service.js';
import type { CognitiveState } from '@may/types';

describe('HUD_Client_Service', () => {
  const mockEdgeClient = {
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    triggerKillSwitch: vi.fn(),
  };

  const createService = () =>
    new HudClientService({
      idGenerator: { uuid: () => 'hud-uuid' },
      clock: { nowISO: () => 'time', nowMs: () => Date.now() },
      edgeAgentClient: mockEdgeClient,
    });

  it('handles pause, resume, and kill switch correctly', async () => {
    const service = createService();

    expect(service.getStatus()).toBe('idle');

    await service.pause();
    expect(mockEdgeClient.pauseAgent).toHaveBeenCalled();
    expect(service.getStatus()).toBe('paused');

    await service.resume();
    expect(mockEdgeClient.resumeAgent).toHaveBeenCalled();
    expect(service.getStatus()).toBe('idle');

    await service.triggerKillSwitch();
    expect(mockEdgeClient.triggerKillSwitch).toHaveBeenCalled();
    expect(service.getStatus()).toBe('offline');
    expect(service.isConsentGranted()).toBe(false);
  });

  it('adapts layout based on focus_depth and interruption_tolerance', () => {
    const service = createService();

    const normalState: CognitiveState = {
      state_id: '1',
      tenant_id: 't-1',
      principal_id: 'u-1',
      timestamp: 'now',
      focus_depth: 0.5 as any,
      interruption_tolerance: 0.6 as any,
      fatigue_score: 0.1 as any,
      task_switch_cost: 0.2 as any,
      cognitive_load: 0.3 as any,
      urgency_pressure: 0.1 as any,
      frustration_probability: 0.05 as any,
    };

    service.adaptLayout(normalState);
    expect(service.getLayoutComplexity()).toBe('normal');
    expect(service.isSuppressSuggestions()).toBe(false);
    expect(service.getSuggestions().length).toBeGreaterThan(0);

    const highFocusState: CognitiveState = {
      ...normalState,
      focus_depth: 0.8 as any,
    };

    service.adaptLayout(highFocusState);
    expect(service.getLayoutComplexity()).toBe('compact'); // Focus > 0.75 -> compact

    const lowToleranceState: CognitiveState = {
      ...normalState,
      interruption_tolerance: 0.2 as any,
    };

    service.adaptLayout(lowToleranceState);
    expect(service.isSuppressSuggestions()).toBe(true); // Tolerance < 0.25 -> suppress
    expect(service.getSuggestions().length).toBe(0);
  });
});
