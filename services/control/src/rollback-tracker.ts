/**
 * Rollback tracker implementation.
 *
 * Records rollback descriptors for MEDIUM+ risk actions that complete
 * with SUCCESS outcome. Provides rollback execution and cleanup of
 * expired descriptors.
 *
 * @module rollback-tracker
 */

import type { ActionRequest, ActionResponse, RiskLevel } from '@may/types';
import type { RollbackDescriptor, RollbackStep } from '@may/types';
import type {
  IClock,
  IIdGenerator,
  IRollbackStore,
  IRollbackStepGenerator,
  IRollbackTracker,
  RollbackConfig,
} from './interfaces/index.js';

/**
 * Dependencies for the RollbackTracker.
 */
export interface RollbackTrackerDependencies {
  readonly clock: IClock;
  readonly idGenerator: IIdGenerator;
  readonly store: IRollbackStore;
  readonly config: RollbackConfig;
}

/** Default rollback retention period in hours */
export const DEFAULT_ROLLBACK_RETENTION_HOURS = 24;

/** Risk levels that require rollback tracking */
const ROLLBACK_RISK_LEVELS: ReadonlySet<RiskLevel> = new Set(['MEDIUM', 'HIGH', 'CRITICAL']);

/**
 * Default rollback step generator for unregistered action types.
 * Generates a generic "undo" step.
 */
class DefaultRollbackStepGenerator implements IRollbackStepGenerator {
  readonly action_type = '*';

  constructor(private readonly idGenerator: IIdGenerator) {}

  async generateSteps(request: ActionRequest, _response: ActionResponse): Promise<RollbackStep[]> {
    return [
      {
        step_id: this.idGenerator.uuid(),
        description: `Reverse ${request.action_type} action (action_id: ${request.action_id})`,
        reverse_action: {
          action_type: `${request.action_type}.rollback`,
          parameters: {
            original_action_id: request.action_id,
            original_parameters: request.parameters,
          },
          timeout_seconds: request.timeout_seconds,
        },
        order: 1,
      },
    ];
  }
}

/**
 * Service that tracks rollback information for executed actions.
 *
 * Only records rollback descriptors for:
 * - Actions with risk level MEDIUM, HIGH, or CRITICAL
 * - Actions that completed with SUCCESS outcome
 *
 * Descriptors are retained per tenant configuration (default 24 hours).
 */
export class RollbackTracker implements IRollbackTracker {
  private readonly generators = new Map<string, IRollbackStepGenerator>();
  private readonly defaultGenerator: DefaultRollbackStepGenerator;
  private readonly clock: IClock;
  private readonly idGenerator: IIdGenerator;
  private readonly store: IRollbackStore;
  private readonly config: RollbackConfig;

  constructor(deps: RollbackTrackerDependencies) {
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
    this.store = deps.store;
    this.config = deps.config;
    this.defaultGenerator = new DefaultRollbackStepGenerator(this.idGenerator);
  }

  registerGenerator(generator: IRollbackStepGenerator): void {
    this.generators.set(generator.action_type, generator);
  }

  async recordRollback(
    request: ActionRequest,
    response: ActionResponse,
  ): Promise<RollbackDescriptor | undefined> {
    // Only record for MEDIUM+ risk levels
    if (!ROLLBACK_RISK_LEVELS.has(request.risk_level)) {
      return undefined;
    }

    // Only record for SUCCESS outcomes
    if (response.outcome !== 'SUCCESS') {
      return undefined;
    }

    const generator = this.generators.get(request.action_type) ?? this.defaultGenerator;
    const rollbackSteps = await generator.generateSteps(request, response);

    const now = this.clock.nowISO();
    const expiresAt = this.computeExpiry(now);

    const descriptor: RollbackDescriptor = {
      descriptor_id: this.idGenerator.uuid(),
      action_id: request.action_id,
      tenant_id: request.context.tenant_id,
      principal_id: request.context.principal_id,
      action_type: request.action_type,
      rollback_steps: rollbackSteps,
      created_at: now,
      expires_at: expiresAt,
      executed: false,
    };

    await this.store.save(descriptor);
    return descriptor;
  }

  async getRollbackDescriptor(
    actionId: string,
    tenantId: string,
  ): Promise<RollbackDescriptor | undefined> {
    return this.store.getByActionId(actionId, tenantId);
  }

  async executeRollback(descriptorId: string, tenantId: string): Promise<RollbackDescriptor> {
    const descriptor = await this.store.getByDescriptorId(descriptorId, tenantId);

    if (!descriptor) {
      throw new Error(`Rollback descriptor not found: ${descriptorId}`);
    }

    if (descriptor.executed) {
      throw new Error(`Rollback already executed for descriptor: ${descriptorId}`);
    }

    const now = this.clock.nowISO();
    if (now > descriptor.expires_at) {
      throw new Error(`Rollback descriptor expired: ${descriptorId}`);
    }

    await this.store.markExecuted(descriptorId, tenantId);

    return {
      ...descriptor,
      executed: true,
    };
  }

  async cleanupExpired(): Promise<number> {
    return this.store.removeExpired();
  }

  private computeExpiry(fromISO: string): string {
    const date = new Date(fromISO);
    date.setHours(date.getHours() + this.config.retention_hours);
    return date.toISOString();
  }
}
