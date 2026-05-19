/**
 * Self-healing selector service implementation.
 *
 * When a selector breaks (element moved/renamed), attempts to find the
 * element using a fallback hierarchy:
 * 1. Accessibility label
 * 2. Text content
 * 3. Visual similarity
 * 4. DOM structure
 *
 * Logs selector migrations in the audit trail.
 *
 * @module self-healing-selector
 */

import type {
  ElementSelector,
  SelectorHealResult,
  SelectorStrategy,
  StrategyAttempt,
  IHealingStrategy,
  HealingContext,
  PageElement,
  ISelectorAuditEmitter,
  ISelfHealingSelector,
  IClock,
} from './interfaces/index.js';

/**
 * Dependencies for the SelfHealingSelector.
 */
export interface SelfHealingSelectorDependencies {
  readonly auditEmitter: ISelectorAuditEmitter;
  readonly clock: IClock;
}

/** Minimum confidence threshold for accepting a healed selector */
export const MIN_HEAL_CONFIDENCE = 0.7;

/**
 * Strategy that matches elements by accessibility label.
 */
export class AccessibilityLabelStrategy implements IHealingStrategy {
  readonly strategy: SelectorStrategy = 'accessibility_label';

  async attempt(selector: ElementSelector, context: HealingContext): Promise<StrategyAttempt> {
    const start = Date.now();

    if (!selector.accessibility_label) {
      return {
        strategy: this.strategy,
        success: false,
        confidence: 0,
        duration_ms: Date.now() - start,
      };
    }

    const label = selector.accessibility_label.toLowerCase();
    const match = context.available_elements.find(
      (el) => el.accessibility_label?.toLowerCase() === label,
    );

    if (match) {
      return {
        strategy: this.strategy,
        success: true,
        confidence: 0.95,
        candidate_selector: match.selector,
        duration_ms: Date.now() - start,
      };
    }

    // Try partial match (only if element has an accessibility label)
    const partialMatch = context.available_elements.find(
      (el) => {
        const elLabel = el.accessibility_label?.toLowerCase();
        if (!elLabel) return false;
        return elLabel.includes(label) || label.includes(elLabel);
      },
    );

    if (partialMatch) {
      return {
        strategy: this.strategy,
        success: true,
        confidence: 0.75,
        candidate_selector: partialMatch.selector,
        duration_ms: Date.now() - start,
      };
    }

    return {
      strategy: this.strategy,
      success: false,
      confidence: 0,
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Strategy that matches elements by text content.
 */
export class TextContentStrategy implements IHealingStrategy {
  readonly strategy: SelectorStrategy = 'text_content';

  async attempt(selector: ElementSelector, context: HealingContext): Promise<StrategyAttempt> {
    const start = Date.now();

    if (!selector.text_content) {
      return {
        strategy: this.strategy,
        success: false,
        confidence: 0,
        duration_ms: Date.now() - start,
      };
    }

    const text = selector.text_content.toLowerCase().trim();

    // Exact text match
    const exactMatch = context.available_elements.find(
      (el) => el.text_content?.toLowerCase().trim() === text,
    );

    if (exactMatch) {
      return {
        strategy: this.strategy,
        success: true,
        confidence: 0.9,
        candidate_selector: exactMatch.selector,
        duration_ms: Date.now() - start,
      };
    }

    // Fuzzy text match (contains, only if element has text content)
    const fuzzyMatch = context.available_elements.find(
      (el) => {
        const elText = el.text_content?.toLowerCase();
        if (!elText) return false;
        return elText.includes(text) || text.includes(elText);
      },
    );

    if (fuzzyMatch) {
      return {
        strategy: this.strategy,
        success: true,
        confidence: 0.7,
        candidate_selector: fuzzyMatch.selector,
        duration_ms: Date.now() - start,
      };
    }

    return {
      strategy: this.strategy,
      success: false,
      confidence: 0,
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Strategy that matches elements by visual similarity (bounding box proximity).
 */
export class VisualSimilarityStrategy implements IHealingStrategy {
  readonly strategy: SelectorStrategy = 'visual_similarity';

  async attempt(selector: ElementSelector, context: HealingContext): Promise<StrategyAttempt> {
    const start = Date.now();

    if (!selector.visual_descriptor?.bounding_box) {
      return {
        strategy: this.strategy,
        success: false,
        confidence: 0,
        duration_ms: Date.now() - start,
      };
    }

    const targetBox = selector.visual_descriptor.bounding_box;
    const targetType = selector.visual_descriptor.element_type;

    let bestMatch: PageElement | undefined;
    let bestDistance = Infinity;

    for (const el of context.available_elements) {
      if (!el.bounding_box) continue;

      // Filter by element type if specified
      if (targetType && el.tag_name.toLowerCase() !== targetType.toLowerCase()) {
        continue;
      }

      const distance = this.computeBoxDistance(targetBox, el.bounding_box);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = el;
      }
    }

    if (bestMatch && bestDistance < 0.1) {
      // Close proximity — high confidence
      const confidence = Math.max(0.7, 1 - bestDistance * 5);
      return {
        strategy: this.strategy,
        success: true,
        confidence: Math.min(confidence, 0.85),
        candidate_selector: bestMatch.selector,
        duration_ms: Date.now() - start,
      };
    }

    return {
      strategy: this.strategy,
      success: false,
      confidence: 0,
      duration_ms: Date.now() - start,
    };
  }

  private computeBoxDistance(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): number {
    const centerAx = a.x + a.width / 2;
    const centerAy = a.y + a.height / 2;
    const centerBx = b.x + b.width / 2;
    const centerBy = b.y + b.height / 2;
    return Math.sqrt((centerAx - centerBx) ** 2 + (centerAy - centerBy) ** 2);
  }
}

/**
 * Strategy that matches elements by DOM structure (tag, parent, siblings, position).
 */
export class DOMStructureStrategy implements IHealingStrategy {
  readonly strategy: SelectorStrategy = 'dom_structure';

  async attempt(selector: ElementSelector, context: HealingContext): Promise<StrategyAttempt> {
    const start = Date.now();

    if (!selector.structural_hints) {
      return {
        strategy: this.strategy,
        success: false,
        confidence: 0,
        duration_ms: Date.now() - start,
      };
    }

    const hints = selector.structural_hints;
    let candidates = [...context.available_elements];

    // Filter by tag name
    if (hints.tag_name) {
      const tagName = hints.tag_name.toLowerCase();
      candidates = candidates.filter((el) => el.tag_name.toLowerCase() === tagName);
    }

    // Filter by parent selector
    if (hints.parent_selector) {
      const parent = hints.parent_selector;
      candidates = candidates.filter((el) => el.parent_selector === parent);
    }

    // Score by position index proximity
    if (hints.position_index !== undefined && candidates.length > 0) {
      candidates.sort((a, b) => {
        const distA = Math.abs((a.position_index ?? 0) - (hints.position_index ?? 0));
        const distB = Math.abs((b.position_index ?? 0) - (hints.position_index ?? 0));
        return distA - distB;
      });
    }

    // Score by sibling context overlap
    if (hints.sibling_context && hints.sibling_context.length > 0) {
      candidates = candidates.filter((el) => {
        if (!el.sibling_selectors) return true;
        const overlap = el.sibling_selectors.filter(
          (s) => hints.sibling_context?.includes(s),
        );
        return overlap.length > 0;
      });
    }

    if (candidates.length > 0) {
      const best = candidates[0]!;
      // Confidence based on how many hints matched
      let matchedHints = 0;
      let totalHints = 0;

      if (hints.tag_name) {
        totalHints++;
        if (best.tag_name.toLowerCase() === hints.tag_name.toLowerCase()) matchedHints++;
      }
      if (hints.parent_selector) {
        totalHints++;
        if (best.parent_selector === hints.parent_selector) matchedHints++;
      }
      if (hints.position_index !== undefined) {
        totalHints++;
        if (best.position_index === hints.position_index) matchedHints++;
      }

      const confidence = totalHints > 0 ? 0.5 + (matchedHints / totalHints) * 0.35 : 0.5;

      return {
        strategy: this.strategy,
        success: true,
        confidence,
        candidate_selector: best.selector,
        duration_ms: Date.now() - start,
      };
    }

    return {
      strategy: this.strategy,
      success: false,
      confidence: 0,
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Self-healing selector service.
 *
 * Attempts to heal broken selectors using a priority-ordered fallback hierarchy.
 * Logs successful migrations to the audit trail.
 */
export class SelfHealingSelector implements ISelfHealingSelector {
  private readonly strategies: IHealingStrategy[];
  private readonly auditEmitter: ISelectorAuditEmitter;
  private readonly clock: IClock;

  constructor(deps: SelfHealingSelectorDependencies) {
    this.auditEmitter = deps.auditEmitter;
    this.clock = deps.clock;

    // Default strategies in priority order
    this.strategies = [
      new AccessibilityLabelStrategy(),
      new TextContentStrategy(),
      new VisualSimilarityStrategy(),
      new DOMStructureStrategy(),
    ];
  }

  registerStrategy(strategy: IHealingStrategy): void {
    this.strategies.push(strategy);
  }

  async heal(
    selector: ElementSelector,
    context: HealingContext,
    actionId: string,
    tenantId: string,
  ): Promise<SelectorHealResult> {
    const attempts: StrategyAttempt[] = [];

    for (const strategy of this.strategies) {
      const attempt = await strategy.attempt(selector, context);
      attempts.push(attempt);

      if (attempt.success && attempt.confidence >= MIN_HEAL_CONFIDENCE && attempt.candidate_selector) {
        // Log the migration
        await this.auditEmitter.emitMigration({
          original_selector: selector.primary,
          new_selector: attempt.candidate_selector,
          strategy_used: attempt.strategy,
          confidence: attempt.confidence,
          timestamp: this.clock.nowISO(),
          action_id: actionId,
          tenant_id: tenantId,
        });

        return {
          healed: true,
          new_selector: attempt.candidate_selector,
          strategy_used: attempt.strategy,
          confidence: attempt.confidence,
          attempts,
        };
      }
    }

    // No strategy succeeded with sufficient confidence
    return {
      healed: false,
      confidence: 0,
      attempts,
    };
  }
}
