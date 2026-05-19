/**
 * Self-healing selector interfaces.
 *
 * When an action targets a UI element or resource by selector and the selector
 * breaks (element moved/renamed), the self-healing system attempts to find the
 * element using alternative strategies following a fallback hierarchy:
 * 1. Accessibility label
 * 2. Text content
 * 3. Visual similarity
 * 4. DOM structure
 */

/**
 * A selector used to identify a UI element.
 */
export interface ElementSelector {
  /** The primary selector (e.g., CSS selector, XPath) */
  readonly primary: string;
  /** Optional accessibility label for fallback */
  readonly accessibility_label?: string;
  /** Optional text content for fallback */
  readonly text_content?: string;
  /** Optional structural hints for DOM-based fallback */
  readonly structural_hints?: StructuralHint;
  /** Optional visual descriptor for visual similarity fallback */
  readonly visual_descriptor?: VisualDescriptor;
}

/**
 * Structural hints about an element's position in the DOM.
 */
export interface StructuralHint {
  /** Tag name of the element */
  readonly tag_name?: string;
  /** Parent element selector */
  readonly parent_selector?: string;
  /** Sibling context (nearby elements) */
  readonly sibling_context?: string[];
  /** Approximate position index among siblings */
  readonly position_index?: number;
}

/**
 * Visual descriptor for visual similarity matching.
 */
export interface VisualDescriptor {
  /** Approximate bounding box (relative coordinates 0-1) */
  readonly bounding_box?: { x: number; y: number; width: number; height: number };
  /** Dominant colors */
  readonly colors?: string[];
  /** Element type hint (button, input, link, etc.) */
  readonly element_type?: string;
}

/**
 * Result of a selector healing attempt.
 */
export interface SelectorHealResult {
  /** Whether healing was successful */
  readonly healed: boolean;
  /** The new selector that was found (if healed) */
  readonly new_selector?: string;
  /** The strategy that succeeded */
  readonly strategy_used?: SelectorStrategy;
  /** Confidence in the healed selector [0.0, 1.0] */
  readonly confidence: number;
  /** All strategies attempted and their results */
  readonly attempts: StrategyAttempt[];
}

/**
 * The fallback strategies in priority order.
 */
export type SelectorStrategy =
  | 'accessibility_label'
  | 'text_content'
  | 'visual_similarity'
  | 'dom_structure';

/**
 * Record of a single strategy attempt.
 */
export interface StrategyAttempt {
  /** The strategy that was tried */
  readonly strategy: SelectorStrategy;
  /** Whether this strategy found a match */
  readonly success: boolean;
  /** Confidence of the match (0 if not found) */
  readonly confidence: number;
  /** The candidate selector found (if any) */
  readonly candidate_selector?: string;
  /** Time taken for this attempt in milliseconds */
  readonly duration_ms: number;
}

/**
 * Interface for a single healing strategy implementation.
 */
export interface IHealingStrategy {
  /** The strategy type */
  readonly strategy: SelectorStrategy;

  /**
   * Attempt to find the element using this strategy.
   * @param selector - The original selector information
   * @param context - The current page/DOM context
   * @returns The attempt result
   */
  attempt(selector: ElementSelector, context: HealingContext): Promise<StrategyAttempt>;
}

/**
 * Context provided to healing strategies about the current page state.
 */
export interface HealingContext {
  /** Current page URL or application identifier */
  readonly page_url?: string;
  /** Available elements on the page (simplified DOM representation) */
  readonly available_elements: PageElement[];
}

/**
 * Simplified representation of a page element for healing purposes.
 */
export interface PageElement {
  /** CSS selector path to this element */
  readonly selector: string;
  /** Tag name */
  readonly tag_name: string;
  /** Text content */
  readonly text_content?: string;
  /** Accessibility label (aria-label, aria-labelledby resolved text) */
  readonly accessibility_label?: string;
  /** Element attributes */
  readonly attributes: Record<string, string>;
  /** Parent selector */
  readonly parent_selector?: string;
  /** Sibling selectors */
  readonly sibling_selectors?: string[];
  /** Position index among siblings */
  readonly position_index?: number;
  /** Bounding box (relative coordinates) */
  readonly bounding_box?: { x: number; y: number; width: number; height: number };
}

/**
 * Audit entry for a selector migration.
 */
export interface SelectorMigrationLog {
  /** Original selector that failed */
  readonly original_selector: string;
  /** New selector that was found */
  readonly new_selector: string;
  /** Strategy that found the new selector */
  readonly strategy_used: SelectorStrategy;
  /** Confidence of the match */
  readonly confidence: number;
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Action ID that triggered the healing */
  readonly action_id: string;
  /** Tenant ID */
  readonly tenant_id: string;
}

/**
 * Audit emitter for selector migrations.
 */
export interface ISelectorAuditEmitter {
  /**
   * Log a selector migration event.
   * @param log - The migration log entry
   */
  emitMigration(log: SelectorMigrationLog): Promise<void>;
}

/**
 * Service responsible for self-healing broken selectors.
 */
export interface ISelfHealingSelector {
  /**
   * Attempt to heal a broken selector using the fallback hierarchy.
   * @param selector - The original selector that failed
   * @param context - The current page/DOM context
   * @param actionId - The action ID for audit purposes
   * @param tenantId - The tenant ID for audit purposes
   * @returns The healing result
   */
  heal(
    selector: ElementSelector,
    context: HealingContext,
    actionId: string,
    tenantId: string,
  ): Promise<SelectorHealResult>;

  /**
   * Register a custom healing strategy.
   * @param strategy - The strategy to register
   */
  registerStrategy(strategy: IHealingStrategy): void;
}
