/**
 * Output filter interface.
 *
 * Defines the contract for filtering LLM output before returning to the caller.
 * Detects and redacts secrets, prohibited PII, executable instructions, and
 * content matching configured deny rules.
 *
 * @see Requirement 4.7 — output-filtering pipeline
 * @see Requirement 20.4 — redact secrets, prohibited PII, executable instructions, deny-rule matches
 */

import type { PIICategory } from '@may/types';

/**
 * Category of content that was filtered from the output.
 */
export type FilteredContentCategory =
  | 'secret'
  | 'pii'
  | 'executable_code'
  | 'deny_rule_match';

/**
 * A single redaction applied to the output.
 */
export interface OutputRedaction {
  /** Category of content that was redacted. */
  readonly category: FilteredContentCategory;

  /** Start offset in the original output. */
  readonly start_offset: number;

  /** End offset in the original output. */
  readonly end_offset: number;

  /** Description of what was redacted (for audit). */
  readonly description: string;

  /** PII category if the redaction was PII-related. */
  readonly pii_category?: PIICategory;
}

/**
 * Tenant-specific output filtering policy.
 */
export interface TenantOutputPolicy {
  /** Tenant identifier. */
  readonly tenant_id: string;

  /** PII categories prohibited in output. */
  readonly prohibited_pii_categories: readonly PIICategory[];

  /** Deny rules — regex patterns that must be redacted from output. */
  readonly deny_rules: readonly DenyRule[];

  /** Whether to redact executable code blocks from output. */
  readonly redact_executable_code: boolean;

  /** Whether to redact detected secrets from output. */
  readonly redact_secrets: boolean;
}

/**
 * A configured deny rule for output filtering.
 */
export interface DenyRule {
  /** Unique identifier for this rule. */
  readonly rule_id: string;

  /** Human-readable description of what this rule blocks. */
  readonly description: string;

  /** Regex pattern to match against output content. */
  readonly pattern: string;
}

/**
 * Result of output filtering.
 */
export interface OutputFilterResult {
  /** The filtered output text with redactions applied. */
  readonly filtered: string;

  /** Whether any modifications were made. */
  readonly was_modified: boolean;

  /** List of redactions applied. */
  readonly redactions: readonly OutputRedaction[];

  /** Total number of redactions applied. */
  readonly redaction_count: number;
}

/**
 * Interface for LLM output filtering.
 *
 * Implementations scan model output and redact:
 * - Secrets (API keys, tokens, passwords)
 * - PII categories prohibited by tenant policy
 * - Executable code blocks (when configured)
 * - Content matching tenant-configured deny rules
 *
 * @see Requirement 4.7 — output-filtering pipeline
 * @see Requirement 20.4 — output-filtering mitigations
 */
export interface IOutputFilter {
  /**
   * Filter LLM output according to tenant policy.
   *
   * @param output - The raw LLM output to filter
   * @param tenantPolicy - The tenant's output filtering policy
   * @returns Filter result with redacted output and details
   */
  filter(output: string, tenantPolicy: TenantOutputPolicy): OutputFilterResult;
}
