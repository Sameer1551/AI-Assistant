/**
 * @module pokg-service
 * POKG_Service: Personal Operating Knowledge Graph
 *
 * @see Requirements 42.1–42.7
 */

export interface WorkflowPattern {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly label: string;
  readonly requiredApps: readonly string[];
  readonly confidence: number;
}

export interface POKGStore {
  savePattern(pattern: WorkflowPattern): Promise<void>;
  getPatterns(tenantId: string, principalId: string): Promise<WorkflowPattern[]>;
  deletePattern(tenantId: string, principalId: string, patternId: string): Promise<void>;
}

export class POKGService {
  constructor(private readonly store: POKGStore) {}

  /**
   * Identifies current workflow type from active applications
   * @see Requirement 42.3
   */
  async identifyWorkflow(
    tenantId: string,
    principalId: string,
    activeApps: string[]
  ): Promise<{ label: string; confidence: number }> {
    const patterns = await this.store.getPatterns(tenantId, principalId);
    
    let bestMatch = { label: 'unknown', confidence: 0.0 };

    for (const pattern of patterns) {
      // Simple subset match
      const isMatch = pattern.requiredApps.every(app => activeApps.includes(app));
      if (isMatch && pattern.confidence > bestMatch.confidence) {
        bestMatch = { label: pattern.label, confidence: pattern.confidence };
      }
    }

    return bestMatch;
  }

  async addLearnedPattern(pattern: WorkflowPattern): Promise<void> {
    await this.store.savePattern(pattern);
  }
}
