import type { GroundedClaim, FreshnessClassification } from '@may/types';

export interface IWebSearchProvider {
  search(query: string): Promise<GroundedClaim[]>;
}

export interface ILocalRagProvider {
  search(query: string): Promise<GroundedClaim[]>;
}

export interface IPromptInjectionDefense {
  sanitize(text: string): string;
}

export interface IFreshnessClassifier {
  classify(query: string): Promise<FreshnessClassification>;
}
