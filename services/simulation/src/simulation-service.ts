/**
 * @module simulation-service
 * Simulation_Service: Action outcome prediction engine.
 *
 * @see Requirements 45.1–45.7
 */

import type { SimulationResult, SimulationRecommendation, RollbackCost } from '@may/types';
import type {
  ISimulationIdGenerator,
  ISimulationClock,
  IAuditPublisher,
  IActionPredictor,
} from './interfaces/index.js';

export interface SimulationServiceDeps {
  readonly idGenerator: ISimulationIdGenerator;
  readonly clock: ISimulationClock;
  readonly auditPublisher: IAuditPublisher;
  readonly predictor: IActionPredictor;
}

export class SimulationService {
  private readonly idGenerator: ISimulationIdGenerator;
  private readonly clock: ISimulationClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly predictor: IActionPredictor;

  constructor(deps: SimulationServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.predictor = deps.predictor;
  }

  private clamp(v: number): number {
    return Math.max(0.0, Math.min(1.0, v));
  }

  /**
   * Evaluate a proposed action and produce a simulation result.
   * Completes within 10s or returns a fallback result.
   *
   * @see Requirement 45.4 (10s timeout fallback)
   */
  async simulateAction(actionId: string, actionPayload: any): Promise<SimulationResult> {
    const startMs = this.clock.nowMs();
    const timeoutMs = 10000;

    let predictedPartial: Partial<SimulationResult> | undefined;

    try {
      // Race predictor against 10s timeout
      predictedPartial = await Promise.race([
        this.predictor.predict(actionPayload),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))
      ]);
    } catch (e) {
      predictedPartial = undefined;
    }

    const elapsedMs = this.clock.nowMs() - startMs;

    let result: SimulationResult;

    if (!predictedPartial) {
      // Timeout or error fallback
      result = {
        simulation_id: this.idGenerator.uuid(),
        action_id: actionId,
        predicted_outcome: 'Simulation timed out or failed.',
        success_probability: 0.5,
        failure_modes: [],
        expected_duration_seconds: 0,
        rollback_cost: 'high',
        side_effects: [],
        resource_delta: { disk_bytes: 0, memory_bytes: 0, network_calls: 0, estimated_cost_units: 0 },
        confidence: 0.0, // Strict requirement 45.4
        recommendation: 'proceed_with_caution', // Strict requirement 45.4
        simulation_duration_ms: elapsedMs,
        timestamp: this.clock.nowISO(),
      };
    } else {
      // Successful prediction
      const failure_modes = (predictedPartial.failure_modes ?? []).slice(0, 3); // Requirement 45.2 (<=3)
      result = {
        simulation_id: this.idGenerator.uuid(),
        action_id: actionId,
        predicted_outcome: predictedPartial.predicted_outcome ?? 'Unknown',
        success_probability: this.clamp(predictedPartial.success_probability ?? 0.5),
        failure_modes,
        expected_duration_seconds: Math.max(0, predictedPartial.expected_duration_seconds ?? 1),
        rollback_cost: predictedPartial.rollback_cost ?? 'moderate',
        side_effects: predictedPartial.side_effects ?? [],
        resource_delta: predictedPartial.resource_delta ?? { disk_bytes: 0, memory_bytes: 0, network_calls: 0, estimated_cost_units: 0 },
        confidence: this.clamp(predictedPartial.confidence ?? 0.8),
        recommendation: predictedPartial.recommendation ?? 'proceed',
        simulation_duration_ms: elapsedMs,
        timestamp: this.clock.nowISO(),
      };
    }

    // Log to Audit_Service (Requirement 45.6)
    await this.auditPublisher.publishAudit({
      type: 'simulation_completed',
      simulationId: result.simulation_id,
      actionId: result.action_id,
      recommendation: result.recommendation,
      confidence: result.confidence,
    });

    return result;
  }

  /**
   * Determine if an execution request can proceed given the simulation result and an optional explicit override.
   *
   * @see Requirement 45.5 (require explicit override when recommendation is "abort")
   */
  canProceed(result: SimulationResult, explicitOverride: boolean = false): boolean {
    if (result.recommendation === 'abort') {
      return explicitOverride;
    }
    return true;
  }
}
