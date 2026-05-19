/**
 * @module knowledge-grounding
 * Data models for the Knowledge_Grounding_Service.
 *
 * The Knowledge_Grounding_Service classifies queries by freshness tier,
 * performs live web search for volatile queries, fuses web results with
 * local RAG memory, and applies prompt-injection defense to web-sourced content.
 *
 * @see Requirement 41.1
 */

import type { UnitScore } from './branded.js';

/**
 * Classification of factual claims by temporal stability.
 * Determines whether live web grounding is required before answering.
 *
 * - TIMELESS: Facts that do not change (e.g., mathematical constants, historical dates)
 * - STABLE: Facts that change infrequently (e.g., API documentation, library versions)
 * - VOLATILE: Facts that change frequently (e.g., stock prices, weather, breaking news)
 */
export type FreshnessTier = 'TIMELESS' | 'STABLE' | 'VOLATILE';

/**
 * The source of a grounded claim, indicating whether it came from
 * local memory/RAG or a live web search.
 */
export type GroundedClaimSource = 'local_memory' | 'live_web';

/**
 * Result of classifying a query by its freshness tier.
 * Used to determine whether live web grounding is needed.
 */
export interface FreshnessClassification {
  /** The original query that was classified */
  readonly query: string;

  /** The assigned freshness tier */
  readonly tier: FreshnessTier;

  /** Confidence in the classification in [0.0, 1.0] */
  readonly confidence: UnitScore;

  /** Human-readable reasoning for the classification decision */
  readonly reasoning: string;
}

/**
 * A single factual claim with provenance and confidence metadata.
 * Claims are sourced from either local memory/RAG or live web search.
 */
export interface GroundedClaim {
  /** The factual claim text */
  readonly claim: string;

  /** Whether this claim came from local memory or live web search */
  readonly source: GroundedClaimSource;

  /** URL of the source, if available (primarily for web-sourced claims) */
  readonly source_url?: string;

  /** The freshness tier of this specific claim */
  readonly freshness_tier: FreshnessTier;

  /** Confidence in the accuracy of this claim in [0.0, 1.0] */
  readonly confidence: UnitScore;
}

/**
 * The fused result of grounding a query against both local RAG memory
 * and live web search results. Provides a combined context block ready
 * for LLM injection.
 */
export interface GroundedContext {
  /** The original query that was grounded */
  readonly query: string;

  /** The freshness tier determined for this query */
  readonly tier: FreshnessTier;

  /** Claims sourced from local memory/RAG */
  readonly local_results: readonly GroundedClaim[];

  /** Claims sourced from live web search */
  readonly web_results: readonly GroundedClaim[];

  /** Combined context block formatted for LLM injection */
  readonly fused_context: string;

  /** Present in Offline_Mode for VOLATILE queries; warns about potential staleness */
  readonly staleness_warning?: string;
}
