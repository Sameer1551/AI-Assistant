/**
 * RotationScheduler - Checks key ages and triggers rotation when approaching limits.
 *
 * Periodically scans all active keys for a tenant and identifies those that
 * are due for rotation based on the configured rotation policy:
 * - Symmetric keys: ≤90 days
 * - Asymmetric keys: ≤365 days
 *
 * @see Requirement 19.3 - Symmetric ≤90 days, asymmetric ≤365 days rotation
 * @see Requirement 19.4 - Retain only 2 most recent key versions
 */

import type { RequestContext } from '@may/types';
import type { ISecretsService, IKeyStore, IClock } from './interfaces/index.js';
import type { KeyMetadata, RotationPolicy } from './types/index.js';
import { DEFAULT_ROTATION_POLICY } from './types/index.js';

// ─── Rotation Check Result ───────────────────────────────────────────────────

/** Result of checking a single key for rotation eligibility. */
export interface RotationCheckResult {
  /** The key metadata that was checked. */
  readonly key: KeyMetadata;

  /** Whether the key is due for rotation. */
  readonly needs_rotation: boolean;

  /** Age of the key in days since last rotation. */
  readonly age_days: number;

  /** Maximum allowed age in days per policy. */
  readonly max_age_days: number;

  /** Days remaining before rotation is required (negative if overdue). */
  readonly days_remaining: number;
}

/** Result of a full rotation scan for a tenant. */
export interface RotationScanResult {
  /** Tenant that was scanned. */
  readonly tenant_id: string;

  /** All keys that were checked. */
  readonly checked: readonly RotationCheckResult[];

  /** Keys that need rotation. */
  readonly due_for_rotation: readonly RotationCheckResult[];

  /** Keys that were successfully rotated. */
  readonly rotated: readonly string[];

  /** Keys that failed rotation (with error details). */
  readonly failed: readonly { key_id: string; error: string }[];

  /** Timestamp of the scan. */
  readonly scanned_at: string;
}

// ─── Dependencies ────────────────────────────────────────────────────────────

/** Dependencies injected into the RotationScheduler. */
export interface RotationSchedulerDependencies {
  /** The secrets service to invoke rotation on. */
  readonly secretsService: ISecretsService;

  /** Key metadata store for scanning keys. */
  readonly keyStore: IKeyStore;

  /** Clock abstraction for testability. */
  readonly clock: IClock;

  /** Rotation policy configuration. */
  readonly rotationPolicy?: RotationPolicy;

  /**
   * Threshold factor (0-1) for triggering rotation early.
   * E.g., 0.9 means rotate when 90% of max age is reached.
   * Default: 1.0 (rotate exactly at max age).
   */
  readonly rotationThresholdFactor?: number;
}

// ─── RotationScheduler Implementation ────────────────────────────────────────

/**
 * Checks key ages and triggers rotation when keys approach their maximum age.
 *
 * This scheduler is designed to be invoked periodically (e.g., via a cron job
 * or timer) to ensure keys are rotated before they exceed policy limits.
 *
 * @example
 * ```typescript
 * const scheduler = new RotationScheduler({ secretsService, keyStore, clock });
 * const result = await scheduler.scanAndRotate(tenantId, ctx);
 * console.log(`Rotated ${result.rotated.length} keys`);
 * ```
 */
export class RotationScheduler {
  private readonly secretsService: ISecretsService;
  private readonly keyStore: IKeyStore;
  private readonly clock: IClock;
  private readonly rotationPolicy: RotationPolicy;
  private readonly thresholdFactor: number;

  constructor(deps: RotationSchedulerDependencies) {
    this.secretsService = deps.secretsService;
    this.keyStore = deps.keyStore;
    this.clock = deps.clock;
    this.rotationPolicy = deps.rotationPolicy ?? DEFAULT_ROTATION_POLICY;
    this.thresholdFactor = deps.rotationThresholdFactor ?? 1.0;
  }

  /**
   * Checks a single key to determine if it needs rotation.
   *
   * @param key - The key metadata to check
   * @returns The rotation check result
   */
  checkKey(key: KeyMetadata): RotationCheckResult {
    const now = this.clock.now();
    const rotatedAt = new Date(key.rotated_at);
    const ageMs = now.getTime() - rotatedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    const maxAgeDays = key.key_type === 'symmetric'
      ? this.rotationPolicy.symmetric_max_age_days
      : this.rotationPolicy.asymmetric_max_age_days;

    const effectiveMaxAge = maxAgeDays * this.thresholdFactor;
    const daysRemaining = maxAgeDays - ageDays;

    return {
      key,
      needs_rotation: ageDays >= effectiveMaxAge,
      age_days: Math.floor(ageDays),
      max_age_days: maxAgeDays,
      days_remaining: Math.floor(daysRemaining),
    };
  }

  /**
   * Scans all active keys for a tenant and identifies those needing rotation.
   *
   * @param tenantId - The tenant to scan
   * @returns Array of rotation check results for keys needing rotation
   */
  async scanKeys(tenantId: string): Promise<readonly RotationCheckResult[]> {
    const keysNeedingRotation = await this.keyStore.getKeysNeedingRotation(
      tenantId,
      this.rotationPolicy,
      this.clock.now(),
    );

    return keysNeedingRotation.map((key) => this.checkKey(key));
  }

  /**
   * Scans all active keys for a tenant and rotates those that are due.
   * This is the primary entry point for scheduled rotation.
   *
   * @param tenantId - The tenant to scan and rotate keys for
   * @param ctx - The request context for the rotation operations
   * @returns Full scan result with rotation outcomes
   */
  async scanAndRotate(tenantId: string, ctx: RequestContext): Promise<RotationScanResult> {
    const allKeys = await this.keyStore.getKeysNeedingRotation(
      tenantId,
      this.rotationPolicy,
      this.clock.now(),
    );

    const checked: RotationCheckResult[] = allKeys.map((key) => this.checkKey(key));
    const dueForRotation = checked.filter((r) => r.needs_rotation);

    const rotated: string[] = [];
    const failed: { key_id: string; error: string }[] = [];

    for (const check of dueForRotation) {
      try {
        await this.secretsService.rotateKey(
          {
            key_id: check.key.key_id,
            tenant_id: check.key.tenant_id,
            correlation_id: ctx.correlation_id,
            force: true, // Scheduler-initiated rotations are always forced
          },
          ctx,
        );
        rotated.push(check.key.key_id);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        failed.push({ key_id: check.key.key_id, error: errorMessage });
      }
    }

    return {
      tenant_id: tenantId,
      checked,
      due_for_rotation: dueForRotation,
      rotated,
      failed,
      scanned_at: this.clock.nowISO(),
    };
  }
}
