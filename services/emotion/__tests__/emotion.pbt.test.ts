/**
 * Property-Based Tests — Emotion Service
 *
 * Property 29:  Emotional State Valid Ranges — valence [-1,1], arousal [0,1], stress [0,1], trend valid
 * Property 30:  No Protected Attribute Inference — no race, ethnicity, religion inferences
 * Property 104: Emotion_Service Read-Only Mode — estimates inform style only, never override safety/risk
 *
 * @see Requirements 7.1, 7.4, 7.6
 */

import { describe, it, expect } from 'vitest';
import { EmotionService, validateEmotionalStateRanges } from '../src/emotion-service.js';
import type { FuseRequest, SensorSignal } from '../src/emotion-service.js';
import type { EmotionalState } from '@may/types';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const mockClock = { nowISO: () => '2025-06-01T12:00:00.000Z' };

function makeService() {
  return new EmotionService(mockClock);
}

function makeSignal(
  sensor: 'text' | 'voice' | 'webcam',
  valence: number,
  arousal: number,
  stress: number,
  confidence = 0.8,
): SensorSignal {
  return {
    sensor,
    raw_affect: { valence, arousal, stress, confidence },
    timestamp: mockClock.nowISO(),
  };
}

// ─── Property 29: Emotional State Valid Ranges ────────────────────────────────

describe('Property 29: Emotional State Valid Ranges', () => {
  it('all affect dimensions are within valid ranges for typical inputs', () => {
    const service = makeService();

    const cases: Array<[number, number, number]> = [
      [-1.0, 0.0, 0.0],
      [1.0, 1.0, 1.0],
      [0.0, 0.5, 0.5],
      [-0.5, 0.7, 0.9],
      [0.8, 0.2, 0.1],
    ];

    for (const [valence, arousal, stress] of cases) {
      const request: FuseRequest = {
        tenant_id: 'tenant-1',
        principal_id: 'user-1',
        signals: [makeSignal('text', valence, arousal, stress)],
        consented_sensors: ['text'],
        export_enabled: false,
      };
      const state = service.fuseAffect(request);

      expect(state.valence).toBeGreaterThanOrEqual(-1.0);
      expect(state.valence).toBeLessThanOrEqual(1.0);
      expect(state.arousal).toBeGreaterThanOrEqual(0.0);
      expect(state.arousal).toBeLessThanOrEqual(1.0);
      expect(state.stress_level).toBeGreaterThanOrEqual(0.0);
      expect(state.stress_level).toBeLessThanOrEqual(1.0);
    }
  });

  it('extreme out-of-range inputs are clamped to valid bounds', () => {
    const service = makeService();
    const request: FuseRequest = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      signals: [makeSignal('voice', 999, 999, 999)],
      consented_sensors: ['voice'],
      export_enabled: false,
    };
    const state = service.fuseAffect(request);

    expect(state.valence).toBeLessThanOrEqual(1.0);
    expect(state.arousal).toBeLessThanOrEqual(1.0);
    expect(state.stress_level).toBeLessThanOrEqual(1.0);
  });

  it('negative-extreme inputs are clamped to valid lower bounds', () => {
    const service = makeService();
    const request: FuseRequest = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      signals: [makeSignal('text', -999, -999, -999)],
      consented_sensors: ['text'],
      export_enabled: false,
    };
    const state = service.fuseAffect(request);

    expect(state.valence).toBeGreaterThanOrEqual(-1.0);
    expect(state.arousal).toBeGreaterThanOrEqual(0.0);
    expect(state.stress_level).toBeGreaterThanOrEqual(0.0);
  });

  it('trend is always from valid set {improving, declining, stable}', () => {
    const service = makeService();
    const validTrends = new Set(['improving', 'declining', 'stable']);

    const inputs = [
      makeSignal('text', 0.8, 0.8, 0.1),
      makeSignal('voice', -0.3, 0.3, 0.8),
      makeSignal('webcam', 0.0, 0.5, 0.5),
    ];

    for (const signal of inputs) {
      const request: FuseRequest = {
        tenant_id: 'tenant-1',
        principal_id: 'user-1',
        signals: [signal],
        consented_sensors: [signal.sensor],
        export_enabled: false,
      };
      const state = service.fuseAffect(request);
      expect(validTrends.has(state.trend)).toBe(true);
    }
  });

  it('validateEmotionalStateRanges returns true for valid state', () => {
    const validState: EmotionalState = {
      dominant_emotion: 'neutral',
      valence: 0.3,
      arousal: 0.5,
      stress_level: 0.2,
      trend: 'stable',
      confidence: 0.8,
      sources: ['text'],
      timestamp: mockClock.nowISO(),
    };
    expect(validateEmotionalStateRanges(validState)).toBe(true);
  });

  it('validateEmotionalStateRanges returns false for out-of-range valence', () => {
    const invalidState: EmotionalState = {
      dominant_emotion: 'neutral',
      valence: 1.5, // out of range
      arousal: 0.5,
      stress_level: 0.2,
      trend: 'stable',
      confidence: 0.8,
      sources: [],
      timestamp: mockClock.nowISO(),
    };
    expect(validateEmotionalStateRanges(invalidState)).toBe(false);
  });
});

// ─── Property 30: No Protected Attribute Inference ────────────────────────────

describe('Property 30: No Protected Attribute Inference', () => {
  const protectedKeywords = ['race', 'ethnicity', 'religion', 'political', 'sexual_orientation', 'gender'];

  it('dominant_emotion label never contains protected attribute keywords', () => {
    const service = makeService();
    const scenarios = [
      makeSignal('text', 0.8, 0.2, 0.1),
      makeSignal('voice', -0.5, 0.8, 0.7),
      makeSignal('webcam', -0.2, 0.3, 0.4),
    ];

    for (const signal of scenarios) {
      const request: FuseRequest = {
        tenant_id: 'tenant-1',
        principal_id: 'user-1',
        signals: [signal],
        consented_sensors: [signal.sensor],
        export_enabled: false,
      };
      const state = service.fuseAffect(request);

      for (const keyword of protectedKeywords) {
        expect(state.dominant_emotion.toLowerCase()).not.toContain(keyword);
      }
    }
  });

  it('returned state contains no protected attribute properties', () => {
    const service = makeService();
    const request: FuseRequest = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      signals: [makeSignal('text', 0.5, 0.5, 0.3)],
      consented_sensors: ['text'],
      export_enabled: false,
    };
    const state = service.fuseAffect(request);

    for (const keyword of protectedKeywords) {
      expect(state).not.toHaveProperty(keyword);
    }
  });
});

// ─── Property 104: Emotion Read-Only Mode ─────────────────────────────────────

describe('Property 104: Emotion_Service Read-Only Mode', () => {
  it('emotional state cannot override a Risk_Level — EmotionalState has no risk level field', () => {
    const service = makeService();
    const request: FuseRequest = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      signals: [makeSignal('voice', -0.9, 0.9, 0.9)],
      consented_sensors: ['voice'],
      export_enabled: false,
    };
    const state = service.fuseAffect(request);

    // EmotionalState must NOT have properties that could override safety gates
    expect(state).not.toHaveProperty('risk_level');
    expect(state).not.toHaveProperty('override_confirmation');
    expect(state).not.toHaveProperty('bypass_safety');
    expect(state).not.toHaveProperty('action_override');
  });

  it('only consented sensors contribute to fused state', () => {
    const service = makeService();
    const request: FuseRequest = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      signals: [
        makeSignal('text', 0.5, 0.3, 0.2),
        makeSignal('webcam', -0.9, 0.9, 0.9), // not consented
      ],
      consented_sensors: ['text'], // only text consented
      export_enabled: false,
    };
    const state = service.fuseAffect(request);

    // Only consented sources should appear
    expect(state.sources).toContain('text');
    expect(state.sources).not.toContain('webcam');
  });

  it('neutral state returned when all consent revoked within 5s', () => {
    const service = makeService();

    service.revokeConsent('tenant-1', 'user-1');

    const request: FuseRequest = {
      tenant_id: 'tenant-1',
      principal_id: 'user-1',
      signals: [makeSignal('text', 0.9, 0.9, 0.9)],
      consented_sensors: ['text'],
      export_enabled: false,
    };
    const state = service.fuseAffect(request);

    // After revocation, should get neutral state (confidence 0)
    expect(state.confidence).toBe(0.0);
    expect(state.sources).toHaveLength(0);
  });
});
