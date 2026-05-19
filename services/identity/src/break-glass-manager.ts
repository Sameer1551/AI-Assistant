/**
 * Break-glass emergency access manager.
 *
 * Manages emergency access grants with:
 * - Dual approval requirement (exactly 2 approvers)
 * - Maximum 4-hour time limit
 * - High-severity audit events at activation and expiration/revocation
 *
 * @see Requirement 12.6 - Break-glass with dual approval, 4h limit, audit events
 */

import type { PrincipalId, ISOTimestamp } from '@may/types';
import type {
  IBreakGlassManager,
  BreakGlassRequest,
  BreakGlassGrant,
  IAuditEmitter,
} from './interfaces/service-auth.js';
import type { IClock, IIdGenerator } from './interfaces/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum break-glass grant duration in seconds (4 hours).
 */
export const MAX_BREAK_GLASS_DURATION_SECONDS = 4 * 60 * 60; // 14400 seconds

/**
 * Required number of approvers for break-glass access.
 */
export const REQUIRED_APPROVER_COUNT = 2;

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Dependencies required by BreakGlassManager (constructor injection).
 */
export interface BreakGlassManagerDependencies {
  /** Clock for time-based validation */
  readonly clock: IClock;
  /** ID generator for grant identifiers */
  readonly idGenerator: IIdGenerator;
  /** Audit event emitter */
  readonly auditEmitter: IAuditEmitter;
  /** Grant store for persisting break-glass grants */
  readonly grantStore: IBreakGlassGrantStore;
}

/**
 * Storage interface for break-glass grants.
 */
export interface IBreakGlassGrantStore {
  /**
   * Store a new break-glass grant.
   *
   * @param grant - The grant to store
   */
  store(grant: BreakGlassGrant): Promise<void>;

  /**
   * Retrieve a grant by its ID.
   *
   * @param grantId - The grant identifier
   * @returns The grant if found, null otherwise
   */
  get(grantId: string): Promise<BreakGlassGrant | null>;

  /**
   * Update a grant (e.g., to mark as revoked).
   *
   * @param grant - The updated grant
   */
  update(grant: BreakGlassGrant): Promise<void>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Manages break-glass emergency access with dual approval and time limits.
 *
 * Lifecycle:
 * 1. Request: Validate dual approval, create grant with 4h expiry
 * 2. Validate: Check grant exists, not expired, not revoked
 * 3. Revoke: Mark grant as revoked, emit audit event
 *
 * All operations emit high-severity audit events for security monitoring.
 */
export class BreakGlassManager implements IBreakGlassManager {
  private readonly clock: IClock;
  private readonly idGenerator: IIdGenerator;
  private readonly auditEmitter: IAuditEmitter;
  private readonly grantStore: IBreakGlassGrantStore;

  constructor(deps: BreakGlassManagerDependencies) {
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator;
    this.auditEmitter = deps.auditEmitter;
    this.grantStore = deps.grantStore;
  }

  /**
   * Request break-glass emergency access.
   *
   * Validates:
   * - Exactly 2 approvers are specified (dual approval)
   * - Requester is not one of the approvers
   * - Reason is non-empty
   * - Target service and action are non-empty
   *
   * @param request - The break-glass access request
   * @returns The granted access on success, null if validation fails
   */
  async requestBreakGlass(request: BreakGlassRequest): Promise<BreakGlassGrant | null> {
    // Validate dual approval requirement
    if (request.approver_ids.length !== REQUIRED_APPROVER_COUNT) {
      await this.emitBreakGlassEvent(
        request.requester_id,
        'break_glass.request_denied',
        'DENIED',
        { reason: 'INSUFFICIENT_APPROVERS', required: REQUIRED_APPROVER_COUNT, provided: request.approver_ids.length },
      );
      return null;
    }

    // Validate requester is not an approver (separation of duties)
    if (
      request.approver_ids[0] === request.requester_id ||
      request.approver_ids[1] === request.requester_id
    ) {
      await this.emitBreakGlassEvent(
        request.requester_id,
        'break_glass.request_denied',
        'DENIED',
        { reason: 'REQUESTER_IS_APPROVER' },
      );
      return null;
    }

    // Validate approvers are distinct
    if (request.approver_ids[0] === request.approver_ids[1]) {
      await this.emitBreakGlassEvent(
        request.requester_id,
        'break_glass.request_denied',
        'DENIED',
        { reason: 'DUPLICATE_APPROVERS' },
      );
      return null;
    }

    // Validate reason is non-empty
    if (!request.reason.trim()) {
      await this.emitBreakGlassEvent(
        request.requester_id,
        'break_glass.request_denied',
        'DENIED',
        { reason: 'EMPTY_REASON' },
      );
      return null;
    }

    // Validate target service and action are non-empty
    if (!request.target_service.trim() || !request.target_action.trim()) {
      await this.emitBreakGlassEvent(
        request.requester_id,
        'break_glass.request_denied',
        'DENIED',
        { reason: 'EMPTY_TARGET' },
      );
      return null;
    }

    // Create the grant with 4h expiry
    const nowSeconds = this.clock.nowSeconds();
    const grantedAt = this.clock.nowISO();
    const expiresAtSeconds = nowSeconds + MAX_BREAK_GLASS_DURATION_SECONDS;
    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString() as ISOTimestamp;

    const grant: BreakGlassGrant = {
      grant_id: this.idGenerator.uuid(),
      requester_id: request.requester_id,
      approvers: request.approver_ids,
      granted_at: grantedAt,
      expires_at: expiresAt,
      target_service: request.target_service,
      target_action: request.target_action,
      revoked: false,
    };

    // Persist the grant
    await this.grantStore.store(grant);

    // Emit high-severity audit event at activation
    await this.emitBreakGlassEvent(
      request.requester_id,
      'break_glass.activated',
      'SUCCESS',
      {
        grant_id: grant.grant_id,
        approvers: [...grant.approvers],
        target_service: grant.target_service,
        target_action: grant.target_action,
        expires_at: grant.expires_at,
        reason: request.reason,
      },
    );

    return grant;
  }

  /**
   * Validate whether a break-glass grant is currently active and valid.
   *
   * @param grantId - The grant identifier to validate
   * @returns True if the grant is active and valid
   */
  async validateBreakGlass(grantId: string): Promise<boolean> {
    const grant = await this.grantStore.get(grantId);

    // Grant must exist
    if (!grant) {
      return false;
    }

    // Grant must not be revoked
    if (grant.revoked) {
      return false;
    }

    // Grant must not be expired
    const nowISO = this.clock.nowISO();
    if (nowISO >= grant.expires_at) {
      // Emit expiration audit event
      await this.emitBreakGlassEvent(
        grant.requester_id,
        'break_glass.expired',
        'EXPIRED',
        {
          grant_id: grant.grant_id,
          target_service: grant.target_service,
          target_action: grant.target_action,
          expired_at: grant.expires_at,
        },
      );
      return false;
    }

    return true;
  }

  /**
   * Revoke a break-glass grant before its natural expiration.
   *
   * @param grantId - The grant identifier to revoke
   * @throws Error if grant does not exist
   */
  async revokeBreakGlass(grantId: string): Promise<void> {
    const grant = await this.grantStore.get(grantId);

    if (!grant) {
      throw new Error(`Break-glass grant not found: ${grantId}`);
    }

    // Already revoked — idempotent
    if (grant.revoked) {
      return;
    }

    // Mark as revoked
    const revokedGrant: BreakGlassGrant = {
      ...grant,
      revoked: true,
    };

    await this.grantStore.update(revokedGrant);

    // Emit high-severity audit event on revocation
    await this.emitBreakGlassEvent(
      grant.requester_id,
      'break_glass.revoked',
      'REVOKED',
      {
        grant_id: grant.grant_id,
        target_service: grant.target_service,
        target_action: grant.target_action,
        revoked_at: this.clock.nowISO(),
      },
    );
  }

  /**
   * Emit a break-glass audit event with HIGH severity.
   */
  private async emitBreakGlassEvent(
    principalId: PrincipalId | string,
    category: string,
    outcome: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEmitter.emit({
      event_category: category,
      severity: 'HIGH',
      principal_id: principalId as string,
      source_service: 'identity-service',
      outcome,
      payload,
    });
  }
}
