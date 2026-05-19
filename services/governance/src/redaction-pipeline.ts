/**
 * Redaction pipeline implementation.
 *
 * Orchestrates PII detection and applies tenant-configured redaction policy
 * (block/flag/redact posture). Generates RedactionResult reports with
 * categories, counts, destination, and policy version.
 *
 * @see Requirement 26.1 - PII detection categories
 * @see Requirement 26.2 - Tenant-configurable redaction policy
 * @see Requirement 26.3 - Redaction reports
 */

import { createHash } from 'node:crypto';
import type {
  PIICategory,
  PIIDetection,
  PIIAction,
  RedactionResult,
  PlatformError,
  RequestContext,
} from '@may/types';
import type {
  IGovernanceService,
  IPIIDetector,
  ITenantPolicyStore,
  PIIMatch,
  RedactionRequest,
} from './interfaces/index.js';

/**
 * Creates a PlatformError for governance failures.
 */
function createGovernanceError(
  code: string,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
): PlatformError {
  return {
    code,
    category: 'AUTHORIZATION',
    severity: 'HIGH',
    message,
    correlation_id: correlationId as PlatformError['correlation_id'],
    source_service: 'Governance_Service',
    retryable: false,
    timestamp: new Date().toISOString(),
    details,
  };
}

/**
 * Creates a PlatformError for missing policy configuration.
 */
function createPolicyNotFoundError(
  tenantId: string,
  correlationId: string,
): PlatformError {
  return {
    code: 'POLICY_NOT_FOUND',
    category: 'VALIDATION',
    severity: 'MEDIUM',
    message: `No redaction policy configured for tenant: ${tenantId}`,
    correlation_id: correlationId as PlatformError['correlation_id'],
    source_service: 'Governance_Service',
    retryable: false,
    timestamp: new Date().toISOString(),
    details: { tenant_id: tenantId },
  };
}

/**
 * Redaction pipeline that applies tenant-configured PII redaction policy.
 *
 * Uses constructor injection for dependencies:
 * - IPIIDetector: detects PII in content
 * - ITenantPolicyStore: retrieves tenant-specific redaction policies
 *
 * Flow:
 * 1. Look up tenant's redaction policy
 * 2. Detect PII in content using the detector
 * 3. Filter detections by configured categories and confidence threshold
 * 4. Apply the configured posture (block/flag/redact)
 * 5. Generate and return a RedactionResult report
 */
export class RedactionPipeline implements IGovernanceService {
  constructor(
    private readonly detector: IPIIDetector,
    private readonly policyStore: ITenantPolicyStore,
  ) {}

  /**
   * Detects and redacts PII from content based on tenant policy.
   *
   * @param request - The redaction request containing content and destination
   * @param ctx - The authenticated request context
   * @returns RedactionResult with detections, redacted content, and metadata
   * @throws PlatformError if tenant policy is not configured
   * @throws PlatformError with code PII_BLOCKED if posture is "block" and PII is detected
   */
  async redact(request: RedactionRequest, ctx: RequestContext): Promise<RedactionResult> {
    const correlationId = ctx.correlation_id as string;

    // Step 1: Look up tenant policy
    const tenantPolicy = await this.policyStore.getRedactionPolicy(request.tenant_id);
    if (!tenantPolicy) {
      throw createPolicyNotFoundError(request.tenant_id, correlationId);
    }

    const { policy, version } = tenantPolicy;

    // Step 2: Detect PII in content
    const categoriesToDetect = policy.categories as readonly PIICategory[];
    const allMatches = this.detector.detect(request.content, categoriesToDetect);

    // Step 3: Filter by confidence threshold
    const filteredMatches = allMatches.filter(
      (match) => match.confidence >= policy.confidence_threshold,
    );

    // Step 4: Apply posture
    const { redactedContent, detections } = this.applyPosture(
      request.content,
      filteredMatches,
      policy.posture,
    );

    // Step 5: If posture is "block" and PII was detected, throw
    if (policy.posture === 'block' && detections.length > 0) {
      throw createGovernanceError(
        'PII_BLOCKED',
        `Content blocked: ${detections.length} PII detection(s) found. Policy posture is "block".`,
        correlationId,
        {
          detection_count: detections.length,
          categories: [...new Set(detections.map((d) => d.category))],
          destination: request.destination,
          policy_version: version,
        },
      );
    }

    // Step 6: Compute original content hash
    const originalHash = createHash('sha256')
      .update(request.content)
      .digest('hex');

    // Step 7: Build and return RedactionResult
    return {
      original_hash: originalHash,
      redacted_content: redactedContent,
      detections,
      policy_version: version,
      destination: request.destination,
    };
  }

  /**
   * Applies the configured posture to detected PII matches.
   *
   * - "redact": Replaces matched text with [REDACTED:<category>] markers
   * - "flag": Leaves content unchanged but marks detections with action "flagged"
   * - "block": Marks detections with action "blocked" (caller handles rejection)
   *
   * @returns The redacted content and detection records
   */
  private applyPosture(
    content: string,
    matches: readonly PIIMatch[],
    posture: 'block' | 'flag' | 'redact',
  ): { redactedContent: string; detections: PIIDetection[] } {
    const detections: PIIDetection[] = [];
    let actionTaken: PIIAction;

    switch (posture) {
      case 'block':
        actionTaken = 'blocked';
        break;
      case 'flag':
        actionTaken = 'flagged';
        break;
      case 'redact':
        actionTaken = 'redacted';
        break;
    }

    // Build detection records
    for (const match of matches) {
      detections.push({
        category: match.category,
        confidence: match.confidence,
        start_offset: match.start_offset,
        end_offset: match.end_offset,
        action_taken: actionTaken,
      });
    }

    // Apply redaction to content if posture is "redact"
    let redactedContent: string;
    if (posture === 'redact' && matches.length > 0) {
      redactedContent = this.replaceMatches(content, matches);
    } else {
      redactedContent = content;
    }

    return { redactedContent, detections };
  }

  /**
   * Replaces matched PII text with redaction markers.
   * Processes matches in reverse order to preserve offsets.
   */
  private replaceMatches(content: string, matches: readonly PIIMatch[]): string {
    // Sort by start_offset descending to preserve earlier offsets
    const sorted = [...matches].sort((a, b) => b.start_offset - a.start_offset);

    let result = content;
    for (const match of sorted) {
      const marker = `[REDACTED:${match.category}]`;
      result = result.slice(0, match.start_offset) + marker + result.slice(match.end_offset);
    }

    return result;
  }
}
