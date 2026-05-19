/**
 * Prompt-injection defense implementation.
 *
 * Detects and sanitizes known prompt-injection patterns including:
 * - "Ignore previous instructions" variants
 * - System prompt leak attempts
 * - Role-play attacks (pretend you are, act as)
 * - Encoding tricks (base64, hex, unicode escapes)
 * - Delimiter injection (closing/opening system tags)
 * - Context manipulation (new conversation, reset)
 *
 * @see Requirement 4.6 — documented prompt-injection defense
 * @see Requirement 20.3 — system-prompt isolation, untrusted-content tagging, detection rules
 */

import type {
  IPromptInjectionDefense,
  InjectionCategory,
  InjectionDetectionResult,
  InjectionSeverity,
  SanitizationResult,
} from './interfaces/index.js';

/**
 * Internal pattern definition for injection detection.
 */
interface InjectionPattern {
  readonly category: InjectionCategory;
  readonly severity: InjectionSeverity;
  readonly pattern: RegExp;
  readonly description: string;
  readonly confidence: number;
}

/**
 * Known injection patterns organized by category.
 *
 * Patterns are designed for high precision to avoid false positives
 * on legitimate user input while catching common attack vectors.
 */
const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  // ─── Ignore Instructions ─────────────────────────────────────────────────
  {
    category: 'ignore_instructions',
    severity: 'high',
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding|the)\s+(?:instructions?|prompts?|rules?|guidelines?|constraints?|directives?)\b/gi,
    description: 'Ignore previous instructions pattern',
    confidence: 0.95,
  },
  {
    category: 'ignore_instructions',
    severity: 'high',
    pattern: /\b(?:do\s+not\s+follow|stop\s+following|discard)\s+(?:your|the|any)\s+(?:instructions?|rules?|system\s+prompt|guidelines?)\b/gi,
    description: 'Do not follow instructions pattern',
    confidence: 0.93,
  },
  {
    category: 'ignore_instructions',
    severity: 'medium',
    pattern: /\bnew\s+instructions?\s*:/gi,
    description: 'New instructions directive',
    confidence: 0.90,
  },
  {
    category: 'ignore_instructions',
    severity: 'high',
    pattern: /\b(?:from\s+now\s+on|starting\s+now|henceforth)\s*,?\s*(?:you\s+(?:are|will|must|should)|ignore|disregard)\b/gi,
    description: 'From now on override pattern',
    confidence: 0.92,
  },

  // ─── System Prompt Leak ──────────────────────────────────────────────────
  {
    category: 'system_prompt_leak',
    severity: 'high',
    pattern: /\b(?:reveal|show|display|print|output|repeat|echo|tell\s+me)\s+(?:your|the)\s+(?:system\s+prompt|initial\s+prompt|instructions?|hidden\s+(?:prompt|instructions?)|original\s+(?:prompt|instructions?))\b/gi,
    description: 'System prompt reveal request',
    confidence: 0.96,
  },
  {
    category: 'system_prompt_leak',
    severity: 'high',
    pattern: /\b(?:what\s+(?:is|are)\s+your|give\s+me\s+your|share\s+your)\s+(?:system\s+prompt|initial\s+instructions?|hidden\s+instructions?|original\s+instructions?|secret\s+instructions?)\b/gi,
    description: 'System prompt query',
    confidence: 0.95,
  },
  {
    category: 'system_prompt_leak',
    severity: 'medium',
    pattern: /\b(?:paste|copy|dump|leak)\s+(?:your|the)\s+(?:system|initial|original|hidden)\s+(?:prompt|message|instructions?)\b/gi,
    description: 'System prompt dump request',
    confidence: 0.94,
  },

  // ─── Role-Play Attacks ───────────────────────────────────────────────────
  {
    category: 'role_play_attack',
    severity: 'high',
    pattern: /\b(?:you\s+are\s+now|pretend\s+(?:you\s+are|to\s+be)|act\s+as\s+(?:if\s+you\s+(?:are|were)|a)|roleplay\s+as|simulate\s+being|behave\s+as)\s+(?:a\s+)?(?:different|new|unrestricted|unfiltered|jailbroken|evil|DAN|uncensored)\b/gi,
    description: 'Role-play jailbreak attempt',
    confidence: 0.94,
  },
  {
    category: 'role_play_attack',
    severity: 'high',
    pattern: /\b(?:enter|switch\s+to|activate|enable)\s+(?:DAN|developer|god|admin|unrestricted|jailbreak|uncensored)\s*(?:mode)?\b/gi,
    description: 'Mode switch jailbreak attempt',
    confidence: 0.96,
  },
  {
    category: 'role_play_attack',
    severity: 'medium',
    pattern: /\b(?:you\s+are\s+now|pretend\s+(?:you\s+are|to\s+be)|act\s+as)\s+(?:a\s+)?(?:hacker|attacker|malicious|criminal)\b/gi,
    description: 'Malicious role-play attempt',
    confidence: 0.93,
  },

  // ─── Encoding Tricks ─────────────────────────────────────────────────────
  {
    category: 'encoding_trick',
    severity: 'medium',
    pattern: /\b(?:decode|interpret|execute|run|eval)\s+(?:this|the\s+following)\s+(?:base64|hex|rot13|binary|encoded)\b/gi,
    description: 'Encoding decode instruction',
    confidence: 0.91,
  },
  {
    category: 'encoding_trick',
    severity: 'medium',
    pattern: /\b(?:base64|atob|btoa)\s*\(\s*['"][A-Za-z0-9+/=]{20,}['"]\s*\)/gi,
    description: 'Base64 function call with payload',
    confidence: 0.92,
  },
  {
    category: 'encoding_trick',
    severity: 'low',
    pattern: /(?:\\u[0-9a-fA-F]{4}){4,}/g,
    description: 'Unicode escape sequence chain',
    confidence: 0.85,
  },
  {
    category: 'encoding_trick',
    severity: 'low',
    pattern: /(?:\\x[0-9a-fA-F]{2}){4,}/g,
    description: 'Hex escape sequence chain',
    confidence: 0.85,
  },

  // ─── Delimiter Injection ─────────────────────────────────────────────────
  {
    category: 'delimiter_injection',
    severity: 'critical',
    pattern: /<\/?(?:system|assistant|user|human|ai|bot|instruction|prompt)>/gi,
    description: 'Chat role delimiter injection',
    confidence: 0.97,
  },
  {
    category: 'delimiter_injection',
    severity: 'high',
    pattern: /\[(?:SYSTEM|INST|\/INST|SYS|\/SYS)\]/gi,
    description: 'Bracket-style system delimiter injection',
    confidence: 0.96,
  },
  {
    category: 'delimiter_injection',
    severity: 'high',
    pattern: /```\s*(?:system|instructions?|prompt)\b/gi,
    description: 'Code block system prompt injection',
    confidence: 0.93,
  },

  // ─── Context Manipulation ────────────────────────────────────────────────
  {
    category: 'context_manipulation',
    severity: 'medium',
    pattern: /\b(?:start\s+(?:a\s+)?new|begin\s+(?:a\s+)?new|reset\s+(?:the\s+)?)\s*(?:conversation|session|context|chat)\b/gi,
    description: 'Context reset attempt',
    confidence: 0.88,
  },
  {
    category: 'context_manipulation',
    severity: 'high',
    pattern: /\b(?:the\s+(?:above|previous)\s+(?:was|is)\s+(?:a\s+)?(?:test|joke|example)|that\s+was\s+(?:just\s+)?(?:a\s+)?test)\b/gi,
    description: 'Context dismissal attempt',
    confidence: 0.89,
  },
];

/**
 * Replacement marker used when sanitizing detected injection patterns.
 */
const REDACTION_MARKER = '[FILTERED]';

/**
 * Prompt-injection defense implementation.
 *
 * Scans user input for known injection patterns and either sanitizes
 * (replaces with redaction markers) or rejects the input entirely
 * when critical-severity patterns are detected.
 *
 * @see Requirement 4.6 — prompt-injection defense
 * @see Requirement 20.3 — system-prompt isolation, untrusted-content tagging, detection rules
 */
export class PromptInjectionDefense implements IPromptInjectionDefense {
  /**
   * Sanitize user input by detecting and neutralizing injection patterns.
   *
   * For critical-severity detections, the input is rejected entirely.
   * For lower severities, the matched patterns are replaced with redaction markers.
   *
   * @param input - The raw user input to sanitize
   * @returns Sanitization result with cleaned input and detection details
   */
  sanitize(input: string): SanitizationResult {
    const detections = this.detectInjection(input);

    if (detections.length === 0) {
      return {
        sanitized: input,
        was_modified: false,
        detections: [],
        rejected: false,
      };
    }

    // Check for critical severity — reject entirely
    const criticalDetection = detections.find((d) => d.severity === 'critical');
    if (criticalDetection) {
      return {
        sanitized: '',
        was_modified: true,
        detections,
        rejected: true,
        rejection_reason: `Critical injection pattern detected: ${criticalDetection.matched_pattern}`,
      };
    }

    // For non-critical: replace matched patterns with redaction markers
    let sanitized = input;
    // Sort detections by start_offset descending to replace from end to start
    // (avoids offset shifting issues)
    const sortedDetections = [...detections]
      .filter((d) => d.start_offset !== undefined && d.end_offset !== undefined)
      .sort((a, b) => (b.start_offset ?? 0) - (a.start_offset ?? 0));

    for (const detection of sortedDetections) {
      if (detection.start_offset !== undefined && detection.end_offset !== undefined) {
        sanitized =
          sanitized.slice(0, detection.start_offset) +
          REDACTION_MARKER +
          sanitized.slice(detection.end_offset);
      }
    }

    return {
      sanitized,
      was_modified: true,
      detections,
      rejected: false,
    };
  }

  /**
   * Detect injection patterns in the given input without modifying it.
   *
   * @param input - The input to scan for injection patterns
   * @returns Array of detection results for all patterns found
   */
  detectInjection(input: string): InjectionDetectionResult[] {
    if (!input || input.trim().length === 0) {
      return [];
    }

    const results: InjectionDetectionResult[] = [];

    for (const injectionPattern of INJECTION_PATTERNS) {
      // Create a fresh regex instance to reset lastIndex
      const regex = new RegExp(
        injectionPattern.pattern.source,
        injectionPattern.pattern.flags,
      );

      let match: RegExpExecArray | null;
      while ((match = regex.exec(input)) !== null) {
        results.push({
          detected: true,
          category: injectionPattern.category,
          severity: injectionPattern.severity,
          confidence: injectionPattern.confidence,
          matched_pattern: injectionPattern.description,
          start_offset: match.index,
          end_offset: match.index + match[0].length,
        });
      }
    }

    return results;
  }
}
