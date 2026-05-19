/**
 * @module tenant
 * TenantConfig — comprehensive tenant configuration interface.
 *
 * Each tenant has isolated configuration controlling data residency, budgets,
 * retention policies, PII handling, feature flags, identity provider settings,
 * concurrency limits, rate limits, and behavioral tuning.
 */

import type { TenantId } from './branded.js';
import type { DataClassification } from './governance.js';
import type { BudgetConfig } from './cost.js';

/**
 * PII redaction posture — how detected PII is handled.
 *
 * - block: Reject the entire content if PII is detected.
 * - flag: Allow content through but flag for review.
 * - redact: Replace PII with redaction markers before processing.
 */
export type PIIRedactionPosture = 'block' | 'flag' | 'redact';

/**
 * PII redaction policy configuration for a tenant.
 */
export interface PIIRedactionPolicy {
  /** PII categories to detect (e.g., "email", "phone", "government_id"). */
  readonly categories: readonly string[];

  /** Minimum confidence threshold for PII detection. Range [0.0, 1.0]. */
  readonly confidence_threshold: number;

  /** How detected PII is handled. */
  readonly posture: PIIRedactionPosture;
}

/**
 * Identity provider configuration for tenant authentication.
 */
export interface IdentityProviderConfig {
  /** OIDC issuer URL for the tenant's identity provider. */
  readonly issuer_url: string;

  /** OAuth2 client ID for the tenant's application registration. */
  readonly client_id: string;

  /** Roles that require multi-factor authentication. */
  readonly mfa_required_roles: readonly string[];
}

/**
 * Concurrency limits for resource-intensive operations.
 */
export interface ConcurrencyLimits {
  /** Maximum concurrent workflow executions per tenant. */
  readonly workflows_per_tenant: number;

  /** Maximum concurrent sandbox executions per tenant. */
  readonly sandbox_executions_per_tenant: number;
}

/**
 * Rate limit configuration for LLM requests.
 */
export interface RateLimitConfig {
  /** Maximum LLM requests per minute for the entire tenant. */
  readonly llm_requests_per_minute: number;

  /** Maximum LLM requests per minute per individual principal. */
  readonly llm_requests_per_principal_per_minute: number;
}

/**
 * Interrupt budget configuration for proactive suggestions.
 */
export interface InterruptBudgetConfig {
  /** Maximum proactive interruptions per hour. */
  readonly max_per_hour: number;

  /** Minimum signal score threshold for delivery. */
  readonly score_threshold: number;
}

/**
 * Comprehensive tenant configuration.
 *
 * @remarks
 * This interface defines all configurable aspects of a tenant's behavior
 * within the Platform. Changes to tenant configuration are audited and
 * may require Tenant_Administrator or Platform_Operator authorization.
 */
export interface TenantConfig {
  /** UUID — unique tenant identifier. */
  readonly tenant_id: TenantId;

  /** Human-readable tenant name. */
  readonly name: string;

  /** Data residency region. All data must be stored and processed within this region. */
  readonly residency_region: string;

  /** Whether the tenant operates in offline mode (no external network calls). */
  readonly offline_mode: boolean;

  /** Budget configuration for cost control. */
  readonly budget: BudgetConfig;

  /** Retention duration in days per data classification level. */
  readonly retention_policies: Readonly<Record<DataClassification, number>>;

  /** PII detection and redaction policy. */
  readonly pii_redaction_policy: PIIRedactionPolicy;

  /** Whether personalization features (habit learning, etc.) are enabled. */
  readonly personalization_enabled: boolean;

  /** Whether biometric processing (face detection, etc.) is enabled. */
  readonly biometric_processing_enabled: boolean;

  /** Whether cognitive state modeling is enabled. */
  readonly cognitive_state_enabled: boolean;

  /** Whether local LoRA fine-tuning is enabled. */
  readonly fine_tuning_enabled: boolean;

  /** SIEM destination URL for audit event forwarding. */
  readonly siem_destination?: string;

  /** Identity provider configuration for authentication. */
  readonly identity_provider: IdentityProviderConfig;

  /** Concurrency limits for resource-intensive operations. */
  readonly concurrency_limits: ConcurrencyLimits;

  /** Rate limit configuration for LLM requests. */
  readonly rate_limits: RateLimitConfig;

  /** Interrupt budget for proactive intelligence suggestions. */
  readonly interrupt_budget: InterruptBudgetConfig;

  /** Days a goal must be blocked before triggering an alert. */
  readonly goal_blocked_days_threshold: number;

  /** Hours to retain rollback descriptors for reversible actions. Default 24. */
  readonly rollback_retention_hours: number;
}
