/**
 * @module emotion
 * @description Data models for the Emotion_Service — multi-modal affect fusion
 * producing emotional state estimates from consented sensor sources.
 *
 * The Emotion_Service operates in read-only mode: emotional state informs
 * communication style only and SHALL NOT override safety gates, bypass
 * confirmations, or alter Risk_Level classifications.
 *
 * @see Requirement 7.1
 */

/**
 * Trend direction of the emotional state over time.
 */
export type EmotionTrend = 'improving' | 'declining' | 'stable';

/**
 * Emotional state estimate produced by the Emotion_Service.
 *
 * The Emotion_Service fuses textual, vocal, and visual affect signals
 * (only from consented sources) into this structured estimate.
 *
 * Valid ranges (enforced at runtime by the Emotion_Service):
 * - valence: [-1.0, 1.0] where -1 is most negative, +1 is most positive
 * - arousal: [0.0, 1.0] where 0 is calm, 1 is highly activated
 * - stress_level: [0.0, 1.0] where 0 is no stress, 1 is maximum stress
 * - confidence: [0.0, 1.0] where 0 is no confidence, 1 is full confidence
 *
 * @see Requirement 7.1 — valence [-1,1], arousal [0,1], stress [0,1], trend {improving, declining, stable}
 * @see Requirement 7.6 — read-only mode, informs style only
 */
export interface EmotionalState {
  /**
   * The dominant emotion label (e.g., "neutral", "focused", "frustrated", "happy").
   */
  readonly dominant_emotion: string;

  /**
   * Emotional valence on a bipolar scale.
   * @minimum -1.0
   * @maximum 1.0
   */
  readonly valence: number;

  /**
   * Emotional arousal level indicating activation intensity.
   * @minimum 0.0
   * @maximum 1.0
   */
  readonly arousal: number;

  /**
   * Estimated stress level.
   * @minimum 0.0
   * @maximum 1.0
   */
  readonly stress_level: number;

  /**
   * Direction of emotional state change over the observation window.
   */
  readonly trend: EmotionTrend;

  /**
   * Confidence in the overall emotional state estimate.
   * Lower confidence indicates fewer or less reliable sensor inputs.
   * @minimum 0.0
   * @maximum 1.0
   */
  readonly confidence: number;

  /**
   * Sensor sources that contributed to this estimate.
   * Only sources with active consent are included.
   * @example ["text", "voice", "webcam"]
   */
  readonly sources: readonly string[];

  /** ISO 8601 timestamp when this estimate was produced. */
  readonly timestamp: string;
}
