/**
 * @module context-intelligence
 * Data models for the Context_Intelligence_Service.
 *
 * The Context_Intelligence_Service assembles a rich ContextPacket from multiple
 * signal sources every 60 seconds, assigns confidence scores to each field,
 * and injects the assembled context into every LLM call.
 *
 * @see Requirement 36.1
 */

import type { UnitScore } from './branded.js';

/**
 * A single field within a ContextPacket, representing one signal source's contribution.
 *
 * Each field carries a confidence score indicating the reliability of the data.
 * Fields with confidence below 0.7 receive uncertainty language in LLM prompts.
 */
export interface ContextField {
  /** The signal name, e.g. "active_application", "active_file", "git_diff", "browser_tabs" */
  readonly name: string;

  /** The signal value; shape depends on the provider */
  readonly value: unknown;

  /** Reliability score for this field in [0.0, 1.0]; below 0.7 triggers uncertainty annotation */
  readonly confidence_score: UnitScore;

  /** Identifier of the provider that contributed this field */
  readonly source_provider: string;

  /** True if the provider timed out and a cached value was used instead */
  readonly is_cached: boolean;

  /** Present when confidence_score < 0.7; describes the uncertainty for LLM prompt injection */
  readonly uncertainty_annotation?: string;
}

/**
 * A structured data object assembled every 60 seconds containing signals from
 * active application, active file, project root, git diff, browser tabs,
 * calendar events, user state, recent errors, and habit patterns.
 *
 * Injected into every LLM call to provide rich contextual awareness.
 */
export interface ContextPacket {
  /** Unique identifier for this packet */
  readonly packet_id: string;

  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Authenticated user principal */
  readonly principal_id: string;

  /** ISO 8601 timestamp when this packet was assembled */
  readonly timestamp: string;

  /** Collection of context fields from registered providers */
  readonly fields: readonly ContextField[];

  /** Time in milliseconds taken to assemble this packet */
  readonly assembled_duration_ms: number;
}
