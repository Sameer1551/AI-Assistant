/**
 * Dry-run preview service implementation.
 *
 * Generates previews of action effects without executing them.
 * Used for MEDIUM+ risk actions before requesting user confirmation.
 *
 * @module dry-run-preview-service
 */

import type { ActionRequest } from '@may/types';
import type { DryRunResult, PredictedEffect, Reversibility } from '@may/types';
import type { IClock, IEffectPredictor, IDryRunPreviewService } from './interfaces/index.js';

/**
 * Dependencies for the DryRunPreviewService.
 */
export interface DryRunPreviewServiceDependencies {
  readonly clock: IClock;
}

/**
 * Default effect predictor used when no specific predictor is registered
 * for an action type. Provides generic predictions based on action metadata.
 */
class DefaultEffectPredictor implements IEffectPredictor {
  readonly action_type = '*';

  async predictEffects(request: ActionRequest): Promise<PredictedEffect[]> {
    return [
      {
        description: `Execute ${request.action_type} action with provided parameters`,
        resource: request.action_type,
        change_type: 'modify',
        confidence: 0.5,
      },
    ];
  }

  async assessReversibility(_request: ActionRequest): Promise<Reversibility> {
    return 'partially_reversible';
  }

  async identifyAffectedResources(request: ActionRequest): Promise<string[]> {
    const resources: string[] = [request.action_type];
    const params = request.parameters;
    if (typeof params['path'] === 'string') {
      resources.push(params['path']);
    }
    if (typeof params['url'] === 'string') {
      resources.push(params['url']);
    }
    if (typeof params['target'] === 'string') {
      resources.push(params['target']);
    }
    return resources;
  }
}

/**
 * Risk assessment messages based on risk level and reversibility.
 */
function generateRiskAssessment(
  request: ActionRequest,
  reversibility: Reversibility,
  effectCount: number,
): string {
  const riskDescriptions: Record<string, string> = {
    MEDIUM: 'moderate',
    HIGH: 'high',
    CRITICAL: 'critical',
  };
  const riskDesc = riskDescriptions[request.risk_level] ?? 'unknown';
  const reversibilityDesc: Record<Reversibility, string> = {
    fully_reversible: 'This action can be fully reversed.',
    partially_reversible: 'This action can only be partially reversed.',
    irreversible: 'WARNING: This action cannot be reversed.',
  };

  return (
    `This ${riskDesc}-risk action will affect ${effectCount} resource(s). ` +
    reversibilityDesc[reversibility]
  );
}

/**
 * Service that generates dry-run previews for actions.
 *
 * Maintains a registry of effect predictors per action type.
 * Falls back to a default predictor for unregistered types.
 */
export class DryRunPreviewService implements IDryRunPreviewService {
  private readonly predictors = new Map<string, IEffectPredictor>();
  private readonly defaultPredictor = new DefaultEffectPredictor();
  private readonly clock: IClock;

  constructor(deps: DryRunPreviewServiceDependencies) {
    this.clock = deps.clock;
  }

  registerPredictor(predictor: IEffectPredictor): void {
    this.predictors.set(predictor.action_type, predictor);
  }

  hasPredictor(actionType: string): boolean {
    return this.predictors.has(actionType);
  }

  async generatePreview(request: ActionRequest): Promise<DryRunResult> {
    const predictor = this.predictors.get(request.action_type) ?? this.defaultPredictor;

    const [predictedEffects, reversibility, affectedResources] = await Promise.all([
      predictor.predictEffects(request),
      predictor.assessReversibility(request),
      predictor.identifyAffectedResources(request),
    ]);

    const riskAssessment = generateRiskAssessment(request, reversibility, affectedResources.length);

    const result: DryRunResult = {
      action_id: request.action_id,
      predicted_effects: predictedEffects,
      risk_assessment: riskAssessment,
      reversibility,
      affected_resources: affectedResources,
      timestamp: this.clock.nowISO(),
    };

    return result;
  }
}
