/**
 * Dry-run preview interfaces.
 *
 * The dry-run preview system executes an action in simulation mode,
 * showing what would happen without actually performing the action.
 * Returns a preview of effects/changes for MEDIUM+ risk actions.
 */

import type { ActionRequest } from '@may/types';
import type { DryRunResult, PredictedEffect, Reversibility } from '@may/types';

/**
 * Strategy interface for predicting effects of a specific action type.
 * Each action type can register its own effect predictor.
 */
export interface IEffectPredictor {
  /** The action type this predictor handles (e.g., "file.delete", "browser.navigate") */
  readonly action_type: string;

  /**
   * Predict the effects of executing the given action.
   * @param request - The action request to analyze
   * @returns Predicted effects of the action
   */
  predictEffects(request: ActionRequest): Promise<PredictedEffect[]>;

  /**
   * Assess the reversibility of the action.
   * @param request - The action request to analyze
   * @returns Reversibility classification
   */
  assessReversibility(request: ActionRequest): Promise<Reversibility>;

  /**
   * Identify resources that would be affected.
   * @param request - The action request to analyze
   * @returns List of affected resource identifiers
   */
  identifyAffectedResources(request: ActionRequest): Promise<string[]>;
}

/**
 * Service responsible for generating dry-run previews of actions.
 */
export interface IDryRunPreviewService {
  /**
   * Generate a dry-run preview for an action without executing it.
   * @param request - The action request to preview
   * @returns The dry-run result describing predicted effects
   */
  generatePreview(request: ActionRequest): Promise<DryRunResult>;

  /**
   * Register an effect predictor for a specific action type.
   * @param predictor - The predictor to register
   */
  registerPredictor(predictor: IEffectPredictor): void;

  /**
   * Check if a preview can be generated for the given action type.
   * @param actionType - The action type to check
   * @returns True if a predictor is registered for this type
   */
  hasPredictor(actionType: string): boolean;
}

/**
 * Clock interface for timestamp generation.
 */
export interface IClock {
  /** Returns the current time as an ISO 8601 string */
  nowISO(): string;
}

/**
 * ID generator interface.
 */
export interface IIdGenerator {
  /** Generate a new UUID */
  uuid(): string;
}
