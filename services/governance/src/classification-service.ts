/**
 * Classification service implementation.
 *
 * Classifies data records according to the tenant's configured taxonomy.
 * Uses DI for the tenant taxonomy store.
 *
 * @see Requirement 25.1 - Tenant-configurable data classification taxonomy
 */

import type { DataClassification, RequestContext } from '@may/types';
import type {
  IClassificationService,
  ITenantTaxonomyStore,
  ClassifyRequest,
  ClassifyResult,
} from './interfaces/classification-service.js';

/**
 * Keyword-based classification inference rules.
 * Maps content patterns to likely classifications.
 */
const CLASSIFICATION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  classification: DataClassification;
  confidence: number;
}> = [
  { pattern: /\b(ssn|social\s*security|tax\s*id|passport)\b/i, classification: 'regulated_pii', confidence: 0.9 },
  { pattern: /\b(patient|diagnosis|medical|health\s*record|hipaa)\b/i, classification: 'regulated_health', confidence: 0.9 },
  { pattern: /\b(account\s*number|routing|swift|iban|credit\s*card|payment)\b/i, classification: 'regulated_financial', confidence: 0.9 },
  { pattern: /\b(secret|password|private\s*key|credential|api\s*key)\b/i, classification: 'restricted', confidence: 0.85 },
  { pattern: /\b(confidential|proprietary|trade\s*secret|nda)\b/i, classification: 'confidential', confidence: 0.8 },
  { pattern: /\b(internal|draft|not\s*for\s*distribution)\b/i, classification: 'internal', confidence: 0.75 },
];

/**
 * ClassificationService classifies data records using the tenant's taxonomy.
 *
 * Supports both explicit classification (when the caller knows the classification)
 * and inferred classification (based on content analysis).
 */
export class ClassificationService implements IClassificationService {
  constructor(private readonly taxonomyStore: ITenantTaxonomyStore) {}

  /**
   * Classifies a data record using the tenant's taxonomy.
   *
   * If an explicit classification is provided and is valid within the tenant's
   * taxonomy, it is used directly. Otherwise, classification is inferred from
   * the content using pattern matching.
   *
   * @param request - The classification request
   * @param ctx - The authenticated request context
   * @returns The classification result
   * @throws Error if the explicit classification is not in the tenant's taxonomy
   */
  async classify(request: ClassifyRequest, _ctx: RequestContext): Promise<ClassifyResult> {
    const tenantId = request.tenant_id;
    const allowedClassifications = await this.taxonomyStore.getAllowedClassifications(tenantId);

    // If explicit classification is provided, validate it against taxonomy
    if (request.explicit_classification) {
      if (!allowedClassifications.includes(request.explicit_classification)) {
        throw new Error(
          `Classification '${request.explicit_classification}' is not in tenant taxonomy. ` +
          `Allowed: ${allowedClassifications.join(', ')}`,
        );
      }

      return {
        record_id: request.record_id,
        classification: request.explicit_classification,
        confidence: 1.0,
        method: 'explicit',
        classified_at: new Date().toISOString(),
      };
    }

    // Infer classification from content
    const inferred = this.inferClassification(request.content, allowedClassifications);

    return {
      record_id: request.record_id,
      classification: inferred.classification,
      confidence: inferred.confidence,
      method: 'inferred',
      classified_at: new Date().toISOString(),
    };
  }

  /**
   * Infers classification from content using pattern matching.
   * Returns the highest-confidence match that is in the tenant's taxonomy.
   * Defaults to 'internal' if no patterns match.
   */
  private inferClassification(
    content: string,
    allowedClassifications: readonly DataClassification[],
  ): { classification: DataClassification; confidence: number } {
    let bestMatch: { classification: DataClassification; confidence: number } | null = null;

    for (const rule of CLASSIFICATION_PATTERNS) {
      if (rule.pattern.test(content) && allowedClassifications.includes(rule.classification)) {
        if (!bestMatch || rule.confidence > bestMatch.confidence) {
          bestMatch = { classification: rule.classification, confidence: rule.confidence };
        }
      }
    }

    if (bestMatch) {
      return bestMatch;
    }

    // Default to 'internal' if available, otherwise first allowed classification
    const defaultClassification = allowedClassifications.includes('internal')
      ? 'internal'
      : allowedClassifications[0] ?? 'internal';

    return { classification: defaultClassification, confidence: 0.5 };
  }
}
