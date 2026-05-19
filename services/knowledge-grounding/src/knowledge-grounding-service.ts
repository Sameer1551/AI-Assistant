/**
 * @module knowledge-grounding-service
 * Knowledge_Grounding_Service: Freshness classification and web grounding.
 *
 * @see Requirements 41.1–41.7
 */

import type { GroundedContext, GroundedClaim } from '@may/types';
import type {
  IWebSearchProvider,
  ILocalRagProvider,
  IPromptInjectionDefense,
  IFreshnessClassifier,
} from './interfaces/index.js';

export interface KnowledgeGroundingDeps {
  readonly classifier: IFreshnessClassifier;
  readonly webSearch: IWebSearchProvider;
  readonly localRag: ILocalRagProvider;
  readonly promptDefense: IPromptInjectionDefense;
}

export class KnowledgeGroundingService {
  private readonly classifier: IFreshnessClassifier;
  private readonly webSearch: IWebSearchProvider;
  private readonly localRag: ILocalRagProvider;
  private readonly promptDefense: IPromptInjectionDefense;

  constructor(deps: KnowledgeGroundingDeps) {
    this.classifier = deps.classifier;
    this.webSearch = deps.webSearch;
    this.localRag = deps.localRag;
    this.promptDefense = deps.promptDefense;
  }

  async groundQuery(query: string, offlineMode: boolean = false): Promise<GroundedContext> {
    // 1. Classify query (Requirement 41.1)
    const classification = await this.classifier.classify(query);

    // 2. Decide if web search is needed (Requirement 41.2, 41.3)
    let needsWebSearch = false;
    if (classification.tier === 'VOLATILE') {
      needsWebSearch = true;
    } else if (classification.tier === 'STABLE' && classification.confidence < 0.85) {
      needsWebSearch = true;
    }

    let webResults: GroundedClaim[] = [];
    let localResults: GroundedClaim[] = [];
    let stalenessWarning: string | undefined;

    // Fetch local results
    localResults = await this.localRag.search(query);

    if (needsWebSearch) {
      if (offlineMode) {
        // Requirement 41.7: In Offline_Mode: skip web search, annotate with staleness warning
        stalenessWarning = 'Warning: Live web search is disabled in offline mode. Information may be stale.';
      } else {
        const rawWebResults = await this.webSearch.search(query);

        // Requirement 41.6: Apply prompt-injection defense to all web-sourced content
        webResults = rawWebResults.map(res => ({
          ...res,
          claim: this.promptDefense.sanitize(res.claim)
        }));
      }
    }

    // 4. Fuse results (Requirement 41.4)
    const fusedLines: string[] = [];
    if (stalenessWarning) {
      fusedLines.push(`[SYSTEM] ${stalenessWarning}`);
    }
    
    if (localResults.length > 0) {
      fusedLines.push('--- LOCAL KNOWLEDGE ---');
      localResults.forEach(r => fusedLines.push(`[${r.freshness_tier}] ${r.claim} (Confidence: ${r.confidence})`));
    }
    
    if (webResults.length > 0) {
      fusedLines.push('--- LIVE WEB KNOWLEDGE ---');
      webResults.forEach(r => fusedLines.push(`[${r.freshness_tier}] ${r.claim} (Source: ${r.source_url ?? 'Unknown'}) (Confidence: ${r.confidence})`));
    }

    return {
      query,
      tier: classification.tier,
      local_results: localResults,
      web_results: webResults,
      fused_context: fusedLines.join('\n'),
      staleness_warning: stalenessWarning,
    };
  }
}
