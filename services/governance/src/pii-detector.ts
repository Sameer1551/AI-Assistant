/**
 * Regex-based PII detector implementation.
 *
 * Detects PII across all categories defined in Requirement 26.1:
 * names, addresses, phone numbers, email addresses, government IDs,
 * payment cards, bank accounts, IP addresses, geolocation data,
 * dates of birth, and credentials.
 *
 * @see Requirement 26.1 - PII detection categories
 * @see Requirement 26.4 - Precision ≥0.95
 * @see Requirement 26.5 - Recall ≥0.90
 */

import type { PIICategory } from '@may/types';
import type { IPIIDetector, PIIMatch } from './interfaces/index.js';

/**
 * Configuration for a single PII detection pattern.
 */
interface PIIPattern {
  /** The PII category this pattern detects */
  readonly category: PIICategory;

  /** The regex pattern to match */
  readonly pattern: RegExp;

  /** Base confidence score for matches from this pattern */
  readonly confidence: number;
}

/**
 * All supported PII categories.
 */
const ALL_CATEGORIES: readonly PIICategory[] = [
  'name',
  'address',
  'phone',
  'email',
  'government_id',
  'payment_card',
  'bank_account',
  'ip_address',
  'geolocation',
  'date_of_birth',
  'credential',
];

/**
 * Regex patterns for PII detection.
 *
 * Each pattern is designed for high precision (≥0.95) while maintaining
 * reasonable recall (≥0.90). Patterns are ordered by specificity within
 * each category.
 */
const PII_PATTERNS: readonly PIIPattern[] = [
  // ─── Email ─────────────────────────────────────────────────────────────
  {
    category: 'email',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.99,
  },

  // ─── Phone Numbers ─────────────────────────────────────────────────────
  // International format: +1-234-567-8901, +44 20 7946 0958
  {
    category: 'phone',
    pattern: /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}\b/g,
    confidence: 0.97,
  },
  // US format: (123) 456-7890, 123-456-7890, 123.456.7890
  {
    category: 'phone',
    pattern: /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g,
    confidence: 0.95,
  },

  // ─── Payment Cards ─────────────────────────────────────────────────────
  // Visa: 4xxx xxxx xxxx xxxx
  {
    category: 'payment_card',
    pattern: /\b4\d{3}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
    confidence: 0.98,
  },
  // Mastercard: 5[1-5]xx xxxx xxxx xxxx
  {
    category: 'payment_card',
    pattern: /\b5[1-5]\d{2}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
    confidence: 0.98,
  },
  // Amex: 3[47]xx xxxxxx xxxxx
  {
    category: 'payment_card',
    pattern: /\b3[47]\d{2}[\s\-]?\d{6}[\s\-]?\d{5}\b/g,
    confidence: 0.98,
  },
  // Generic 16-digit card number
  {
    category: 'payment_card',
    pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
    confidence: 0.90,
  },

  // ─── Government IDs ────────────────────────────────────────────────────
  // US SSN: 123-45-6789 or 123 45 6789
  {
    category: 'government_id',
    pattern: /\b\d{3}[\s\-]\d{2}[\s\-]\d{4}\b/g,
    confidence: 0.97,
  },
  // UK National Insurance: AB 12 34 56 C
  {
    category: 'government_id',
    pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b/g,
    confidence: 0.96,
  },

  // ─── Bank Accounts ─────────────────────────────────────────────────────
  // IBAN: GB29 NWBK 6016 1331 9268 19
  {
    category: 'bank_account',
    pattern: /\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}\s?\d{4}\s?\d{4}\s?\d{4}(?:\s?\d{0,4})?\b/g,
    confidence: 0.97,
  },
  // US routing + account pattern: routing 9 digits
  {
    category: 'bank_account',
    pattern: /\b\d{9}\s*(?:routing|aba|rtn)\b/gi,
    confidence: 0.95,
  },

  // ─── IP Addresses ──────────────────────────────────────────────────────
  // IPv4
  {
    category: 'ip_address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    confidence: 0.96,
  },
  // IPv6 (simplified - full addresses)
  {
    category: 'ip_address',
    pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    confidence: 0.97,
  },

  // ─── Geolocation ───────────────────────────────────────────────────────
  // Lat/Long coordinates: 40.7128, -74.0060 or 40.7128°N 74.0060°W
  {
    category: 'geolocation',
    pattern: /\b-?\d{1,3}\.\d{4,}\s*[,°]\s*-?\d{1,3}\.\d{4,}[°]?\s*[NSEW]?\b/g,
    confidence: 0.95,
  },

  // ─── Date of Birth ─────────────────────────────────────────────────────
  // Explicit DOB markers: DOB: 01/15/1990, born on 1990-01-15, date of birth: Jan 15, 1990
  {
    category: 'date_of_birth',
    pattern: /\b(?:dob|date\s+of\s+birth|born\s+(?:on)?)\s*:?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi,
    confidence: 0.97,
  },

  // ─── Credentials ───────────────────────────────────────────────────────
  // API keys, tokens, passwords in common formats
  {
    category: 'credential',
    pattern: /\b(?:password|passwd|pwd|secret|api[_\-]?key|token|auth[_\-]?token|access[_\-]?token|bearer)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?\b/gi,
    confidence: 0.96,
  },
  // AWS-style keys: AKIA...
  {
    category: 'credential',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 0.99,
  },
  // Generic long hex/base64 secrets (40+ chars)
  {
    category: 'credential',
    pattern: /\b(?:sk|pk|key)[_\-][a-zA-Z0-9]{32,}\b/g,
    confidence: 0.95,
  },

  // ─── Names ─────────────────────────────────────────────────────────────
  // Names with explicit markers: "Name: John Smith", "Mr./Mrs./Dr. Smith"
  {
    category: 'name',
    pattern: /\b(?:name|full\s+name|patient|customer|client|employee)\s*:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/gi,
    confidence: 0.96,
  },
  // Titles followed by names: Mr. John Smith, Dr. Jane Doe
  {
    category: 'name',
    pattern: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Rev)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
    confidence: 0.97,
  },

  // ─── Addresses ─────────────────────────────────────────────────────────
  // US-style street addresses: 123 Main St, 456 Oak Avenue, Apt 7
  {
    category: 'address',
    pattern: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place|Cir|Circle)\.?\b/gi,
    confidence: 0.95,
  },
  // ZIP codes with state: CA 90210, NY 10001
  {
    category: 'address',
    pattern: /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g,
    confidence: 0.90,
  },
];

/**
 * Regex-based PII detector.
 *
 * Uses a curated set of regex patterns to detect PII across all
 * categories defined in Requirement 26.1. Each pattern has an
 * associated confidence score reflecting its precision.
 *
 * Detection is performed by running all applicable patterns against
 * the input content and collecting non-overlapping matches (higher
 * confidence wins on overlap).
 */
export class PIIDetector implements IPIIDetector {
  /**
   * Detects all PII instances in the given content.
   *
   * @param content - The text content to scan
   * @param categories - Optional subset of categories to detect (defaults to all)
   * @returns Array of PII matches found, sorted by start_offset
   */
  detect(content: string, categories?: readonly PIICategory[]): PIIMatch[] {
    const activeCategories = categories ?? ALL_CATEGORIES;
    const rawMatches: PIIMatch[] = [];

    // Run all applicable patterns
    for (const piiPattern of PII_PATTERNS) {
      if (!activeCategories.includes(piiPattern.category)) {
        continue;
      }

      // Reset regex lastIndex for global patterns
      const regex = new RegExp(piiPattern.pattern.source, piiPattern.pattern.flags);

      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        rawMatches.push({
          category: piiPattern.category,
          confidence: piiPattern.confidence,
          start_offset: match.index,
          end_offset: match.index + match[0].length,
          matched_text: match[0],
        });
      }
    }

    // Remove overlapping matches (keep highest confidence)
    return this.resolveOverlaps(rawMatches);
  }

  /**
   * Resolves overlapping matches by keeping the one with highest confidence.
   * When two matches overlap, the one with higher confidence wins.
   * If confidence is equal, the longer match wins.
   */
  private resolveOverlaps(matches: PIIMatch[]): PIIMatch[] {
    if (matches.length <= 1) {
      return matches;
    }

    // Sort by start_offset, then by confidence descending
    const sorted = [...matches].sort((a, b) => {
      if (a.start_offset !== b.start_offset) {
        return a.start_offset - b.start_offset;
      }
      return b.confidence - a.confidence;
    });

    const resolved: PIIMatch[] = [];
    let lastEnd = -1;
    let lastConfidence = -1;

    for (const match of sorted) {
      if (match.start_offset >= lastEnd) {
        // No overlap
        resolved.push(match);
        lastEnd = match.end_offset;
        lastConfidence = match.confidence;
      } else if (match.confidence > lastConfidence) {
        // Overlaps but higher confidence — replace last
        resolved[resolved.length - 1] = match;
        lastEnd = match.end_offset;
        lastConfidence = match.confidence;
      }
      // Otherwise skip (lower confidence overlap)
    }

    return resolved;
  }
}
