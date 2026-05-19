/**
 * @module personality-service
 * Personality_Service: Adapts communication style while maintaining core character.
 *
 * @see Requirements 38.1–38.6
 */

import type { CoreCharacterDefinition, StyleProfile, StyleProfileName, DriftBenchmarkResult } from '@may/types';
import { toUnitScore } from '@may/types';
import type {
  IPersonalityIdGenerator,
  IPersonalityClock,
  IPersonalityAlertEmitter,
  StyleSelectionContext,
} from './interfaces/index.js';

export interface PersonalityServiceDeps {
  readonly idGenerator: IPersonalityIdGenerator;
  readonly clock: IPersonalityClock;
  readonly alertEmitter: IPersonalityAlertEmitter;
  readonly driftThreshold?: number;
}

const DEFAULT_CORE_CHARACTER: CoreCharacterDefinition = {
  values: ['safety', 'clarity', 'helpfulness', 'integrity'],
  behavioral_constraints: ['maintain professional distance', 'prioritize accuracy over pleasantry'],
  prohibited_behaviors: ['hallucinating facts', 'expressing unprompted emotions', 'taking unsafe actions'],
  version: '1.0.0',
};

const PROFILES: Record<StyleProfileName, StyleProfile> = {
  deep_work: {
    name: 'deep_work',
    verbosity: 'minimal',
    tone: 'direct',
    formality: 'neutral',
    energy: 'low',
    format_preference: 'bullet_points',
    pleasantries: false,
  },
  casual_chat: {
    name: 'casual_chat',
    verbosity: 'moderate',
    tone: 'warm',
    formality: 'informal',
    energy: 'medium',
    format_preference: 'full_sentences',
    pleasantries: true,
  },
  late_night: {
    name: 'late_night',
    verbosity: 'minimal',
    tone: 'calm',
    formality: 'informal',
    energy: 'low',
    format_preference: 'bullet_points',
    pleasantries: false,
  },
  high_stress: {
    name: 'high_stress',
    verbosity: 'moderate',
    tone: 'grounding',
    formality: 'formal',
    energy: 'low',
    format_preference: 'structured_agenda',
    pleasantries: false,
  },
  morning_briefing: {
    name: 'morning_briefing',
    verbosity: 'full',
    tone: 'energising',
    formality: 'formal',
    energy: 'high',
    format_preference: 'structured_agenda',
    pleasantries: true,
  },
};

export class PersonalityService {
  private readonly idGenerator: IPersonalityIdGenerator;
  private readonly clock: IPersonalityClock;
  private readonly alertEmitter: IPersonalityAlertEmitter;
  private readonly driftThreshold: number;
  private readonly coreCharacter: CoreCharacterDefinition;

  constructor(deps: PersonalityServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.alertEmitter = deps.alertEmitter;
    this.driftThreshold = deps.driftThreshold ?? 0.8; // Requirement 38.6
    this.coreCharacter = DEFAULT_CORE_CHARACTER; // Requirement 38.1 (Immutable core character)
  }

  /**
   * Get the immutable core character definition.
   */
  getCoreCharacter(): CoreCharacterDefinition {
    return this.coreCharacter;
  }

  /**
   * Select exactly one Style_Profile deterministically based on context.
   *
   * @see Requirement 38.3
   */
  selectStyleProfile(context: StyleSelectionContext): StyleProfile {
    // Deterministic selection logic
    if (context.stressLevel > 0.7) {
      return PROFILES.high_stress;
    }
    
    if (context.focusDepth > 0.75) {
      return PROFILES.deep_work;
    }

    if (context.timeOfDay >= 22 || context.timeOfDay < 5) {
      return PROFILES.late_night;
    }

    if (context.timeOfDay >= 6 && context.timeOfDay < 9) {
      return PROFILES.morning_briefing;
    }

    return PROFILES.casual_chat;
  }

  /**
   * Generate a directive string based on the selected profile to inject into LLM prompts.
   *
   * @see Requirement 38.4
   */
  generateStyleDirective(profile: StyleProfile): string {
    const lines = [
      `[STYLE: ${profile.name.toUpperCase()}]`,
      `- Verbosity: ${profile.verbosity}`,
      `- Tone: ${profile.tone}`,
      `- Formality: ${profile.formality}`,
      `- Energy: ${profile.energy}`,
      `- Format Preference: ${profile.format_preference}`,
      `- Pleasantries: ${profile.pleasantries ? 'Enabled' : 'Disabled'}`,
    ];
    return lines.join('\n');
  }

  /**
   * Check style drift against active profile.
   * Alerts and returns a command to revert to default if score < threshold.
   *
   * @see Requirement 38.6
   */
  async checkDrift(
    measuredScore: number,
    promptsEvaluated: number = 1
  ): Promise<{ result: DriftBenchmarkResult; revertToDefault: boolean }> {
    const scoreClamp = Math.max(0.0, Math.min(1.0, measuredScore));
    const isDriftDetected = scoreClamp < this.driftThreshold;
    const benchmarkId = this.idGenerator.uuid();

    if (isDriftDetected) {
      await this.alertEmitter.emitDriftAlert(benchmarkId, scoreClamp, this.driftThreshold);
    }

    const result: DriftBenchmarkResult = {
      benchmark_id: benchmarkId,
      timestamp: this.clock.nowISO(),
      overall_score: toUnitScore(scoreClamp),
      dimension_scores: { consistency: scoreClamp },
      prompts_evaluated: promptsEvaluated,
      drift_detected: isDriftDetected,
      alert_emitted: isDriftDetected,
    };

    return {
      result,
      revertToDefault: isDriftDetected,
    };
  }
}
