/**
 * Prompt-injection defense interface.
 *
 * Defines the contract for detecting and sanitizing prompt-injection attacks
 * before user input reaches the language model.
 *
 * @see Requirement 4.6 — documented prompt-injection defense
 * @see Requirement 20.3 — system-prompt isolation, untrusted-content tagging, detection rules
 */

/**
 * Severity level of a detected injection attempt.
 */
export type InjectionSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Category of injection pattern detected.
 */
export type InjectionCategory =
  | 'ignore_instructions'
  | 'system_prompt_leak'
  | 'role_play_attack'
  | 'encoding_trick'
  | 'delimiter_injection'
  | 'context_manipulation';

/**
 * Result of an injection detection scan.
 */
export interface InjectionDetectionResult {
  /** Whether an injection pattern was detected. */
  readonly detected: boolean;

  /** The category of injection detected, if any. */
  readonly category?: InjectionCategory;

  /** Severity of the detected injection. */
  readonly severity?: InjectionSeverity;

  /** Confidence score of the detection [0.0, 1.0]. */
  readonly confidence?: number;

  /** The matched pattern description (for audit/logging). */
  readonly matched_pattern?: string;

  /** Start offset of the detected pattern in the input. */
  readonly start_offset?: number;

  /** End offset of the detected pattern in the input. */
  readonly end_offset?: number;
}

/**
 * Result of input sanitization.
 */
export interface SanitizationResult {
  /** The sanitized input text. */
  readonly sanitized: string;

  /** Whether any modifications were made. */
  readonly was_modified: boolean;

  /** List of injection detections found during sanitization. */
  readonly detections: readonly InjectionDetectionResult[];

  /** Whether the input was rejected entirely (too dangerous to sanitize). */
  readonly rejected: boolean;

  /** Reason for rejection, if rejected. */
  readonly rejection_reason?: string;
}

/**
 * Interface for prompt-injection defense.
 *
 * Implementations detect known injection patterns and sanitize user input
 * before it reaches the language model. This includes:
 * - Input sanitization rules
 * - System-prompt isolation
 * - Detection of known injection patterns
 *
 * @see Requirement 4.6 — prompt-injection defense
 * @see Requirement 20.3 — system-prompt isolation, untrusted-content tagging, detection rules
 */
export interface IPromptInjectionDefense {
  /**
   * Sanitize user input by detecting and neutralizing injection patterns.
   *
   * @param input - The raw user input to sanitize
   * @returns Sanitization result with cleaned input and detection details
   */
  sanitize(input: string): SanitizationResult;

  /**
   * Detect injection patterns in the given input without modifying it.
   *
   * @param input - The input to scan for injection patterns
   * @returns Array of detection results for all patterns found
   */
  detectInjection(input: string): InjectionDetectionResult[];
}
