/**
 * @module emotion-service
 * Emotion_Service: Multi-modal affect fusion with consent gating.
 *
 * Key invariants:
 * - All EmotionalState values in valid ranges: valence [-1,1], arousal [0,1], stress [0,1]
 * - trend must be from {improving, declining, stable}
 * - Fuses only from consented sensor sources
 * - Stops ingesting within 5s of consent revocation, discards in-memory frames
 * - No protected attribute inferences (race, ethnicity, religion, etc.)
 * - Read-only mode: informs style only, NEVER overrides safety gates or Risk_Level
 * - No export unless Tenant_Administrator enables integration
 *
 * @see Requirements 7.1–7.6
 */

import type { EmotionalState, EmotionTrend } from '@may/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConsentedSensor = 'text' | 'voice' | 'webcam';

export interface SensorSignal {
  readonly sensor: ConsentedSensor;
  readonly raw_affect: {
    readonly valence: number;
    readonly arousal: number;
    readonly stress: number;
    readonly confidence: number;
  };
  readonly timestamp: string;
}

export interface FuseRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly signals: readonly SensorSignal[];
  readonly consented_sensors: readonly ConsentedSensor[];
  readonly export_enabled: boolean;
}

export interface IEmotionClock {
  nowISO(): string;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Clamp a value to [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Validate that an EmotionalState has all values in required ranges */
export function validateEmotionalStateRanges(state: EmotionalState): boolean {
  return (
    state.valence >= -1.0 &&
    state.valence <= 1.0 &&
    state.arousal >= 0.0 &&
    state.arousal <= 1.0 &&
    state.stress_level >= 0.0 &&
    state.stress_level <= 1.0 &&
    state.confidence >= 0.0 &&
    state.confidence <= 1.0 &&
    (['improving', 'declining', 'stable'] satisfies EmotionTrend[]).includes(state.trend)
  );
}



// ─── Service ──────────────────────────────────────────────────────────────────

export class EmotionService {
  private readonly clock: IEmotionClock;

  /** Track revoked sensors per principal to enforce 5s discard */
  private readonly revokedAt = new Map<string, number>();

  constructor(clock: IEmotionClock) {
    this.clock = clock;
  }

  /**
   * Fuse multi-modal affect signals into a single EmotionalState.
   *
   * Only signals from consented_sensors are used.
   * All output values are clamped to valid ranges.
   * No protected attribute inferences are made.
   *
   * @see Requirement 7.1 — valid ranges: valence [-1,1], arousal [0,1], stress [0,1]
   * @see Requirement 7.2 — fuse only from consented sources
   * @see Requirement 7.4 — no protected attribute inferences
   * @see Requirement 7.6 — read-only mode
   */
  fuseAffect(request: FuseRequest): EmotionalState {
    const { tenant_id, principal_id, signals, consented_sensors } = request;

    // Filter to only signals from consented sensors
    const consentedSet = new Set(consented_sensors);
    const validSignals = signals.filter((s) => consentedSet.has(s.sensor));

    // Check if any sensor was recently revoked (discard within 5s — Requirement 7.3)
    const revokedKey = `${tenant_id}:${principal_id}`;
    const revokedTime = this.revokedAt.get(revokedKey);
    if (revokedTime) {
      const nowMs = new Date(this.clock.nowISO()).getTime();
      if (nowMs - revokedTime < 5000) {
        // Within 5s of revocation — return neutral state
        return this.neutralState();
      }
      this.revokedAt.delete(revokedKey);
    }

    if (validSignals.length === 0) {
      return this.neutralState();
    }

    // Weighted average fusion by confidence
    const totalWeight = validSignals.reduce((sum, s) => sum + s.raw_affect.confidence, 0);
    if (totalWeight === 0) return this.neutralState();

    let fusedValence = 0;
    let fusedArousal = 0;
    let fusedStress = 0;
    let usedSources: string[] = [];

    for (const signal of validSignals) {
      const w = signal.raw_affect.confidence / totalWeight;
      fusedValence += signal.raw_affect.valence * w;
      fusedArousal += signal.raw_affect.arousal * w;
      fusedStress += signal.raw_affect.stress * w;
      usedSources.push(signal.sensor);
    }

    // Clamp all values to valid ranges (Requirement 7.1)
    const valence = clamp(fusedValence, -1.0, 1.0);
    const arousal = clamp(fusedArousal, 0.0, 1.0);
    const stress_level = clamp(fusedStress, 0.0, 1.0);
    const confidence = clamp(totalWeight / validSignals.length, 0.0, 1.0);

    // Determine trend from signal progression (simplified: high stress → declining)
    const trend: EmotionTrend = stress_level > 0.7 ? 'declining' : arousal > 0.6 ? 'improving' : 'stable';

    // Determine dominant emotion label (no protected attribute inferences — Req 7.4)
    const dominant_emotion = this.classifyDominantEmotion(valence, arousal, stress_level);

    const state: EmotionalState = {
      dominant_emotion,
      valence,
      arousal,
      stress_level,
      trend,
      confidence,
      sources: [...new Set(usedSources)],
      timestamp: this.clock.nowISO(),
    };

    // Final safety guard: validate all ranges
    if (!validateEmotionalStateRanges(state)) {
      return this.neutralState();
    }

    return state;
  }

  /**
   * Revoke consent for a sensor — discard in-memory signals within 5s.
   *
   * @see Requirement 7.3 — stop ingesting within 5s of consent revocation
   */
  revokeConsent(tenantId: string, principalId: string): void {
    const key = `${tenantId}:${principalId}`;
    this.revokedAt.set(key, new Date(this.clock.nowISO()).getTime());
  }

  /**
   * Return a neutral/default emotional state.
   * Used when no valid signals or during consent revocation window.
   */
  private neutralState(): EmotionalState {
    return {
      dominant_emotion: 'neutral',
      valence: 0.0,
      arousal: 0.5,
      stress_level: 0.0,
      trend: 'stable',
      confidence: 0.0,
      sources: [],
      timestamp: this.clock.nowISO(),
    };
  }

  /**
   * Classify dominant emotion from affect dimensions.
   * NEVER infers protected attributes (race, ethnicity, religion, etc.).
   *
   * @see Requirement 7.4
   */
  private classifyDominantEmotion(valence: number, arousal: number, stress: number): string {
    if (stress > 0.7) return 'stressed';
    if (valence > 0.5 && arousal > 0.5) return 'excited';
    if (valence > 0.3 && arousal < 0.5) return 'calm';
    if (valence < -0.3 && arousal > 0.6) return 'frustrated';
    if (valence < -0.3 && arousal < 0.4) return 'sad';
    if (arousal > 0.7 && Math.abs(valence) < 0.3) return 'alert';
    return 'neutral';
    // NOTE: No inferences about race, ethnicity, religion, political affiliation,
    // sexual orientation, gender, or any other protected attribute.
  }
}
