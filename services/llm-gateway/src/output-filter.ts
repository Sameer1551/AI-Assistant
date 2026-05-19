/**
 * Output filter implementation.
 *
 * Scans LLM output and redacts:
 * - Secrets (API keys, tokens, passwords, connection strings)
 * - PII categories prohibited by tenant policy
 * - Executable code blocks (when configured)
 * - Content matching tenant-configured deny rules
 *
 * @see Requirement 4.7 — output-filtering pipeline
 * @see Requirement 20.4 — redact secrets, prohibited PII, executable instructions, deny-rule matches
 */

import type { PIICategory } from '@may/types';
import type {
  IOutputFilter,
  TenantOutputPolicy,
  OutputFilterResult,
  OutputRedaction,
} from './interfaces/index.js';

/**
 * Internal pattern for secret detection in output.
 */
interface SecretPattern {
  readonly pattern: RegExp;
  readonly description: string;
}

/**
 * Patterns for detecting secrets in LLM output.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // API keys with common prefixes
  {
    pattern: /\b(?:sk|pk|api|key|token)[_\-][a-zA-Z0-9_\-]{20,}\b/g,
    description: 'API key/token with prefix',
  },
  // AWS access keys
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    description: 'AWS access key',
  },
  // AWS secret keys (40 char base64)
  {
    pattern: /\b[A-Za-z0-9/+=]{40}\b(?=\s|$|[,;])/g,
    description: 'Potential AWS secret key',
  },
  // Generic password/secret assignments
  {
    pattern: /\b(?:password|passwd|pwd|secret|api[_\-]?key|auth[_\-]?token|access[_\-]?token|bearer|private[_\-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
    description: 'Password/secret assignment',
  },
  // Connection strings
  {
    pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
    description: 'Database connection string with credentials',
  },
  // JWT tokens
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    description: 'JWT token',
  },
  // GitHub tokens
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    description: 'GitHub token',
  },
  // Private key blocks
  {
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    description: 'Private key block',
  },
];

/**
 * Patterns for detecting PII in output (subset used for output filtering).
 */
const PII_PATTERNS: ReadonlyMap<PIICategory, readonly { pattern: RegExp; description: string }[]> = new Map([
  ['email', [
    { pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, description: 'Email address' },
  ]],
  ['phone', [
    { pattern: /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}\b/g, description: 'International phone' },
    { pattern: /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g, description: 'US phone number' },
  ]],
  ['government_id', [
    { pattern: /\b\d{3}[\s\-]\d{2}[\s\-]\d{4}\b/g, description: 'SSN' },
  ]],
  ['payment_card', [
    { pattern: /\b4\d{3}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, description: 'Visa card' },
    { pattern: /\b5[1-5]\d{2}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, description: 'Mastercard' },
    { pattern: /\b3[47]\d{2}[\s\-]?\d{6}[\s\-]?\d{5}\b/g, description: 'Amex card' },
  ]],
  ['credential', [
    { pattern: /\b(?:password|passwd|pwd|secret|api[_\-]?key|token|auth[_\-]?token|access[_\-]?token|bearer)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?\b/gi, description: 'Credential assignment' },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, description: 'AWS key' },
  ]],
  ['ip_address', [
    { pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, description: 'IPv4 address' },
  ]],
  ['name', [
    { pattern: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, description: 'Named person' },
  ]],
  ['address', [
    { pattern: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place)\.?\b/gi, description: 'Street address' },
  ]],
  ['bank_account', [
    { pattern: /\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}\s?\d{4}\s?\d{4}\s?\d{4}(?:\s?\d{0,4})?\b/g, description: 'IBAN' },
  ]],
  ['date_of_birth', [
    { pattern: /\b(?:dob|date\s+of\s+birth|born\s+(?:on)?)\s*:?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})\b/gi, description: 'Date of birth' },
  ]],
  ['geolocation', [
    { pattern: /\b-?\d{1,3}\.\d{4,}\s*[,°]\s*-?\d{1,3}\.\d{4,}[°]?\s*[NSEW]?\b/g, description: 'GPS coordinates' },
  ]],
]);

/**
 * Pattern for detecting executable code blocks in output.
 */
const EXECUTABLE_CODE_PATTERN = /```\s*(?:bash|sh|shell|powershell|ps1|cmd|bat|zsh|fish|exec|sudo|rm|del|format|mkfs)\b[\s\S]*?```/gi;

/**
 * Redaction placeholder used when content is filtered.
 */
const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Output filter implementation.
 *
 * Applies a multi-stage filtering pipeline:
 * 1. Secret detection and redaction
 * 2. PII detection for prohibited categories
 * 3. Executable code block detection
 * 4. Deny-rule pattern matching
 *
 * All stages produce redaction records for audit purposes.
 *
 * @see Requirement 4.7 — output-filtering pipeline
 * @see Requirement 20.4 — output-filtering mitigations
 */
export class OutputFilter implements IOutputFilter {
  /**
   * Filter LLM output according to tenant policy.
   *
   * @param output - The raw LLM output to filter
   * @param tenantPolicy - The tenant's output filtering policy
   * @returns Filter result with redacted output and details
   */
  filter(output: string, tenantPolicy: TenantOutputPolicy): OutputFilterResult {
    if (!output) {
      return {
        filtered: output,
        was_modified: false,
        redactions: [],
        redaction_count: 0,
      };
    }

    const allRedactions: OutputRedaction[] = [];

    // Stage 1: Detect secrets
    if (tenantPolicy.redact_secrets) {
      const secretRedactions = this.detectSecrets(output);
      allRedactions.push(...secretRedactions);
    }

    // Stage 2: Detect prohibited PII
    if (tenantPolicy.prohibited_pii_categories.length > 0) {
      const piiRedactions = this.detectProhibitedPII(
        output,
        tenantPolicy.prohibited_pii_categories,
      );
      allRedactions.push(...piiRedactions);
    }

    // Stage 3: Detect executable code blocks
    if (tenantPolicy.redact_executable_code) {
      const codeRedactions = this.detectExecutableCode(output);
      allRedactions.push(...codeRedactions);
    }

    // Stage 4: Apply deny rules
    if (tenantPolicy.deny_rules.length > 0) {
      const denyRedactions = this.applyDenyRules(output, tenantPolicy.deny_rules);
      allRedactions.push(...denyRedactions);
    }

    if (allRedactions.length === 0) {
      return {
        filtered: output,
        was_modified: false,
        redactions: [],
        redaction_count: 0,
      };
    }

    // Resolve overlaps and apply redactions
    const resolvedRedactions = this.resolveOverlaps(allRedactions);
    const filtered = this.applyRedactions(output, resolvedRedactions);

    return {
      filtered,
      was_modified: true,
      redactions: resolvedRedactions,
      redaction_count: resolvedRedactions.length,
    };
  }

  /**
   * Detect secrets in the output.
   */
  private detectSecrets(output: string): OutputRedaction[] {
    const redactions: OutputRedaction[] = [];

    for (const secretPattern of SECRET_PATTERNS) {
      const regex = new RegExp(secretPattern.pattern.source, secretPattern.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(output)) !== null) {
        redactions.push({
          category: 'secret',
          start_offset: match.index,
          end_offset: match.index + match[0].length,
          description: secretPattern.description,
        });
      }
    }

    return redactions;
  }

  /**
   * Detect prohibited PII categories in the output.
   */
  private detectProhibitedPII(
    output: string,
    prohibitedCategories: readonly PIICategory[],
  ): OutputRedaction[] {
    const redactions: OutputRedaction[] = [];

    for (const category of prohibitedCategories) {
      const patterns = PII_PATTERNS.get(category);
      if (!patterns) continue;

      for (const piiPattern of patterns) {
        const regex = new RegExp(piiPattern.pattern.source, piiPattern.pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(output)) !== null) {
          redactions.push({
            category: 'pii',
            start_offset: match.index,
            end_offset: match.index + match[0].length,
            description: piiPattern.description,
            pii_category: category,
          });
        }
      }
    }

    return redactions;
  }

  /**
   * Detect executable code blocks in the output.
   */
  private detectExecutableCode(output: string): OutputRedaction[] {
    const redactions: OutputRedaction[] = [];
    const regex = new RegExp(EXECUTABLE_CODE_PATTERN.source, EXECUTABLE_CODE_PATTERN.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(output)) !== null) {
      redactions.push({
        category: 'executable_code',
        start_offset: match.index,
        end_offset: match.index + match[0].length,
        description: 'Executable code block',
      });
    }

    return redactions;
  }

  /**
   * Apply tenant-configured deny rules.
   */
  private applyDenyRules(
    output: string,
    denyRules: readonly { rule_id: string; description: string; pattern: string }[],
  ): OutputRedaction[] {
    const redactions: OutputRedaction[] = [];

    for (const rule of denyRules) {
      try {
        const regex = new RegExp(rule.pattern, 'gi');
        let match: RegExpExecArray | null;

        while ((match = regex.exec(output)) !== null) {
          redactions.push({
            category: 'deny_rule_match',
            start_offset: match.index,
            end_offset: match.index + match[0].length,
            description: `Deny rule: ${rule.description} (${rule.rule_id})`,
          });
        }
      } catch {
        // Invalid regex in deny rule — skip silently (should be validated at config time)
      }
    }

    return redactions;
  }

  /**
   * Resolve overlapping redactions by merging overlapping ranges.
   * Keeps the broader category and description from the first match.
   */
  private resolveOverlaps(redactions: OutputRedaction[]): OutputRedaction[] {
    if (redactions.length <= 1) {
      return redactions;
    }

    // Sort by start_offset
    const sorted = [...redactions].sort((a, b) => a.start_offset - b.start_offset);
    const resolved: OutputRedaction[] = [sorted[0]!];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i]!;
      const last = resolved[resolved.length - 1]!;

      if (current.start_offset <= last.end_offset) {
        // Overlapping — merge by extending end_offset
        if (current.end_offset > last.end_offset) {
          resolved[resolved.length - 1] = {
            ...last,
            end_offset: current.end_offset,
          };
        }
      } else {
        resolved.push(current);
      }
    }

    return resolved;
  }

  /**
   * Apply redactions to the output string, replacing matched ranges with placeholder.
   */
  private applyRedactions(output: string, redactions: OutputRedaction[]): string {
    // Apply from end to start to preserve offsets
    const sortedDesc = [...redactions].sort((a, b) => b.start_offset - a.start_offset);
    let result = output;

    for (const redaction of sortedDesc) {
      result =
        result.slice(0, redaction.start_offset) +
        REDACTION_PLACEHOLDER +
        result.slice(redaction.end_offset);
    }

    return result;
  }
}
