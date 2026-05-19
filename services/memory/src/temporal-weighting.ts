/**
 * @module temporal-weighting
 * Temporal memory weighting for relevance scoring.
 *
 * Implements four compounding factors per Requirements 43.1–43.6:
 *  1. Half-life decay per memory layer
 *  2. Frequency boost (capped)
 *  3. Priority boost for unresolved/active records
 *  4. Intent graph resonance boost for matching intent labels
 *
 * Final composite score = base_relevance × temporal × frequency × priority × intent
 */

import type { MemoryRecord, MemoryLayer } from '@may/types';
import type { MemoryWeightingConfig } from './interfaces/index.js';

/**
 * Compute the temporal decay factor for a record.
 *
 * temporal_factor = 0.5^(age_days / half_life_days)
 *
 * At age = half_life_days: factor = 0.5 (50% reduction)
 * At age = 0:              factor = 1.0 (no decay)
 *
 * @see Requirement 43.2 — half-life decay per memory type
 */
export function computeTemporalDecay(
  layer: MemoryLayer,
  createdAt: string,
  config: MemoryWeightingConfig,
  now: Date,
): number {
  const halfLifeDays = config.half_life_days[layer];
  const createdMs = new Date(createdAt).getTime();
  const ageMs = now.getTime() - createdMs;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Compute the frequency boost for a record.
 *
 * boost = min(1 + log10(1 + access_count) * 0.3, frequency_boost_max)
 *
 * @see Requirement 43.3 — frequency boost capped at configurable max (default 1.3)
 */
export function computeFrequencyBoost(
  accessCount: number,
  config: MemoryWeightingConfig,
): number {
  const rawBoost = 1 + Math.log10(1 + accessCount) * 0.3;
  return Math.min(rawBoost, config.frequency_boost_max);
}

/**
 * Compute the priority boost for a record.
 *
 * Records with status "unresolved" or "active" receive priority_boost_factor.
 *
 * @see Requirement 43.4 — priority boost for "unresolved"/"active" status (default 1.4×)
 */
export function computePriorityBoost(
  metadata: Readonly<Record<string, string>>,
  config: MemoryWeightingConfig,
): number {
  const status = metadata['status']?.toLowerCase();
  if (status === 'unresolved' || status === 'active') {
    return config.priority_boost_factor;
  }
  return 1.0;
}

/**
 * Compute the intent graph resonance boost.
 *
 * Records whose metadata contains labels matching the provided
 * Intent_Node labels receive intent_resonance_boost.
 *
 * @see Requirement 43.5 — intent graph resonance boost (default 1.5×)
 */
export function computeIntentResonanceBoost(
  metadata: Readonly<Record<string, string>>,
  intentNodeLabels: readonly string[],
  config: MemoryWeightingConfig,
): number {
  if (intentNodeLabels.length === 0) return 1.0;

  const recordLabels = (metadata['intent_labels'] ?? '').split(',').map((l) => l.trim().toLowerCase());
  const queryLabels = intentNodeLabels.map((l) => l.toLowerCase());
  const hasMatch = recordLabels.some((label) => label && queryLabels.includes(label));

  return hasMatch ? config.intent_resonance_boost : 1.0;
}

/**
 * Compute the composite temporal score for a memory record.
 *
 * temporal_score = temporal_decay × frequency_boost × priority_boost × intent_boost
 */
export function computeTemporalScore(
  record: MemoryRecord,
  accessCount: number,
  intentNodeLabels: readonly string[],
  config: MemoryWeightingConfig,
  now: Date,
): number {
  const temporal = computeTemporalDecay(record.layer, record.created_at, config, now);
  const frequency = computeFrequencyBoost(accessCount, config);
  const priority = computePriorityBoost(record.metadata, config);
  const intent = computeIntentResonanceBoost(record.metadata, intentNodeLabels, config);

  return temporal * frequency * priority * intent;
}
