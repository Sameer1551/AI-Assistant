/**
 * @module cognitive-state-service
 * Cognitive_State_Service: Models user cognitive state and generates directives.
 *
 * @see Requirements 37.1–37.7
 */

import type { CognitiveState, CognitiveDirective } from '@may/types';
import { toUnitScore } from '@may/types';
import type {
  ObservableSignals,
  ICognitiveIdGenerator,
  ICognitiveClock,
  IProactiveIntelligencePublisher,
} from './interfaces/index.js';

export interface CognitiveStateServiceDeps {
  readonly idGenerator: ICognitiveIdGenerator;
  readonly clock: ICognitiveClock;
  readonly proactivePublisher: IProactiveIntelligencePublisher;
}

export class CognitiveStateService {
  private readonly idGenerator: ICognitiveIdGenerator;
  private readonly clock: ICognitiveClock;
  private readonly proactivePublisher: IProactiveIntelligencePublisher;

  constructor(deps: CognitiveStateServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.proactivePublisher = deps.proactivePublisher;
  }

  /** Clamp value to [0.0, 1.0] */
  private clamp(v: number): number {
    return Math.max(0.0, Math.min(1.0, v));
  }

  /**
   * Produce a CognitiveState vector and CognitiveDirective based on observable signals.
   *
   * @see Requirement 37.1 — produce CognitiveState vector updated every ≤30s
   * @see Requirement 37.2 — all 7 fields in [0.0, 1.0]
   * @see Requirement 37.3 — derive from observable signals
   * @see Requirement 37.4 — publish interruption tolerance
   * @see Requirement 37.5 — generate cognitive directive
   * @see Requirement 37.7 — return default neutral state if feature disabled
   */
  async processSignals(
    tenantId: string,
    principalId: string,
    signals: ObservableSignals,
    featureEnabled: boolean,
  ): Promise<{ state: CognitiveState; directive: CognitiveDirective }> {
    if (!featureEnabled) {
      // Requirement 37.7: Return default neutral state
      const state = this.createStateObject(tenantId, principalId, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
      return { state, directive: this.generateDirective(state) };
    }

    // Heuristics for deriving cognitive state from signals
    // High keystroke velocity + low app switching = high focus depth
    const focusRaw = (Math.min(signals.keystrokeVelocity / 300, 1.0) * 0.7) + 
                     ((signals.appSwitchCount === 0 ? 1.0 : (1.0 / signals.appSwitchCount)) * 0.3);
    const focus_depth = this.clamp(focusRaw);

    // High focus depth or high urgency = low interruption tolerance
    const interruption_tolerance = this.clamp(1.0 - (focus_depth * 0.8));

    // Long session duration = higher fatigue
    const fatigue_score = this.clamp(signals.sessionDurationMinutes / 120);

    // High focus depth = high task switch cost
    const task_switch_cost = this.clamp(focus_depth * 0.9);

    // High app switching + high keystroke = high cognitive load
    const loadRaw = (Math.min(signals.appSwitchCount / 10, 1.0) * 0.6) + 
                    (Math.min(signals.keystrokeVelocity / 200, 1.0) * 0.4);
    const cognitive_load = this.clamp(loadRaw);

    // Proximity to next meeting
    const urgency_pressure = this.clamp(
      signals.minutesToNextMeeting < 15 ? (15 - signals.minutesToNextMeeting) / 15 : 0.0
    );

    // High error frequency = high frustration
    const frustration_probability = this.clamp(Math.min(signals.errorFrequency / 20, 1.0));

    const state = this.createStateObject(
      tenantId,
      principalId,
      focus_depth,
      interruption_tolerance,
      fatigue_score,
      task_switch_cost,
      cognitive_load,
      urgency_pressure,
      frustration_probability
    );

    // Publish interruption tolerance (Requirement 37.4)
    await this.proactivePublisher.publishInterruptionTolerance(tenantId, principalId, state.interruption_tolerance);

    const directive = this.generateDirective(state);

    return { state, directive };
  }

  private createStateObject(
    tenantId: string,
    principalId: string,
    focus: number,
    interruption: number,
    fatigue: number,
    switchCost: number,
    load: number,
    urgency: number,
    frustration: number
  ): CognitiveState {
    return {
      state_id: this.idGenerator.uuid(),
      tenant_id: tenantId,
      principal_id: principalId,
      timestamp: this.clock.nowISO(),
      focus_depth: toUnitScore(focus),
      interruption_tolerance: toUnitScore(interruption),
      fatigue_score: toUnitScore(fatigue),
      task_switch_cost: toUnitScore(switchCost),
      cognitive_load: toUnitScore(load),
      urgency_pressure: toUnitScore(urgency),
      frustration_probability: toUnitScore(frustration),
    };
  }

  private generateDirective(state: CognitiveState): CognitiveDirective {
    // Requirement 37.5: extremely brief during deep focus (>0.75), calm/solution-first during high frustration (>0.7)
    let response_style: 'extremely_brief' | 'brief' | 'normal' | 'detailed' = 'normal';
    let tone: 'calm' | 'energetic' | 'neutral' | 'grounding' = 'neutral';
    let directive_text = 'Respond normally.';

    if (state.focus_depth > 0.75) {
      response_style = 'extremely_brief';
      directive_text = 'User is in deep focus. Respond with extreme brevity. Avoid pleasantries. Provide only the exact answer or action requested.';
    } else if (state.frustration_probability > 0.7) {
      response_style = 'brief';
      tone = 'calm';
      directive_text = 'User exhibits high frustration. Be extremely calm, empathetic, and solution-oriented. Avoid overly cheerful language. Get straight to the fix.';
    } else if (state.fatigue_score > 0.7) {
      tone = 'grounding';
      directive_text = 'User exhibits fatigue. Provide clear, step-by-step guidance. Do not overwhelm with options.';
    }

    return {
      directive_text,
      response_style,
      tone,
      based_on_state: state,
    };
  }
}
