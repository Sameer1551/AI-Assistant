/**
 * Residency enforcer implementation.
 *
 * Validates that data operations comply with the tenant's configured
 * Data_Residency_Region across persistence and processing boundaries.
 *
 * @see Requirement 25.4 - Data_Residency_Region enforcement
 * @see Requirement 25.5 - Region migration planning
 */

import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@may/types';
import type {
  IResidencyEnforcer,
  ITenantTaxonomyStore,
  ResidencyValidationRequest,
  ResidencyValidationResult,
  ResidencyMigrationPlan,
  MigrationStep,
} from './interfaces/classification-service.js';

/**
 * Default components that require migration when residency region changes.
 */
const MIGRATION_COMPONENTS: readonly string[] = [
  'Memory_Service',
  'Audit_Service',
  'Workflow_Service',
  'Habit_Service',
  'Telemetry_Service',
  'Code_Sandbox_Service',
];

/**
 * ResidencyEnforcer validates data operations against the tenant's
 * configured Data_Residency_Region.
 *
 * All persistence and processing operations must occur within the
 * tenant's configured region. If a tenant changes region, a migration
 * plan must be produced and completed before processing in the new region.
 */
export class ResidencyEnforcer implements IResidencyEnforcer {
  constructor(private readonly taxonomyStore: ITenantTaxonomyStore) {}

  /**
   * Validates whether a data operation is allowed in the target region.
   *
   * The operation is allowed only if the target region matches the tenant's
   * configured residency region.
   *
   * @param request - The validation request
   * @param ctx - The authenticated request context
   * @returns Validation result indicating whether the operation is allowed
   */
  async validate(
    request: ResidencyValidationRequest,
    ctx: RequestContext,
  ): Promise<ResidencyValidationResult> {
    const configuredRegion = await this.taxonomyStore.getResidencyRegion(request.tenant_id);

    const allowed = this.regionsMatch(request.target_region, configuredRegion);

    return {
      allowed,
      configured_region: configuredRegion,
      target_region: request.target_region,
      denial_reason: allowed
        ? undefined
        : `Operation in region '${request.target_region}' violates tenant residency constraint. ` +
          `Tenant data must remain in '${configuredRegion}'.`,
    };
  }

  /**
   * Produces a migration plan when a tenant changes residency region.
   *
   * The plan includes steps for each component that stores tenant data.
   * Processing in the new region must not begin until migration is complete
   * and verified.
   *
   * @param tenantId - The tenant changing regions
   * @param sourceRegion - The current region
   * @param targetRegion - The new region
   * @returns A migration plan with steps for each affected component
   */
  async createMigrationPlan(
    tenantId: string,
    sourceRegion: string,
    targetRegion: string,
  ): Promise<ResidencyMigrationPlan> {
    const steps: MigrationStep[] = MIGRATION_COMPONENTS.map((component) => ({
      step_id: randomUUID(),
      description: `Migrate ${component} data from '${sourceRegion}' to '${targetRegion}'`,
      component,
      status: 'pending' as const,
    }));

    // Add a verification step at the end
    steps.push({
      step_id: randomUUID(),
      description: `Verify all data migrated and accessible in '${targetRegion}'`,
      component: 'Governance_Service',
      status: 'pending',
    });

    return {
      tenant_id: tenantId,
      source_region: sourceRegion,
      target_region: targetRegion,
      steps,
      verified: false,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Compares two region identifiers for equality.
   * Case-insensitive comparison to handle region naming variations.
   */
  private regionsMatch(regionA: string, regionB: string): boolean {
    return regionA.toLowerCase().trim() === regionB.toLowerCase().trim();
  }
}
