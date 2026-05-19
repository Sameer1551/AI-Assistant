/**
 * Unit tests for PIIDetector.
 *
 * Verifies detection of all PII categories defined in Requirement 26.1:
 * names, addresses, phone numbers, email addresses, government IDs,
 * payment cards, bank accounts, IP addresses, geolocation, DOB, credentials.
 */

import { describe, it, expect } from 'vitest';
import { PIIDetector } from '../src/pii-detector.js';
import type { PIICategory } from '@may/types';

describe('PIIDetector', () => {
  const detector = new PIIDetector();

  // ─── Email Detection ─────────────────────────────────────────────────────

  describe('email detection', () => {
    it('should detect standard email addresses', () => {
      const content = 'Contact us at john.doe@example.com for more info.';
      const matches = detector.detect(content, ['email']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('email');
      expect(matches[0]!.matched_text).toBe('john.doe@example.com');
      expect(matches[0]!.confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('should detect multiple email addresses', () => {
      const content = 'Send to alice@corp.io and bob@university.edu';
      const matches = detector.detect(content, ['email']);

      expect(matches).toHaveLength(2);
      expect(matches[0]!.matched_text).toBe('alice@corp.io');
      expect(matches[1]!.matched_text).toBe('bob@university.edu');
    });

    it('should detect emails with plus addressing', () => {
      const content = 'Use user+tag@gmail.com for filtering.';
      const matches = detector.detect(content, ['email']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.matched_text).toBe('user+tag@gmail.com');
    });
  });

  // ─── Phone Number Detection ──────────────────────────────────────────────

  describe('phone number detection', () => {
    it('should detect US phone numbers with dashes', () => {
      const content = 'Call me at 555-123-4567 anytime.';
      const matches = detector.detect(content, ['phone']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('phone');
      expect(matches[0]!.matched_text).toBe('555-123-4567');
    });

    it('should detect phone numbers with parentheses', () => {
      const content = 'Phone: (555) 123-4567';
      const matches = detector.detect(content, ['phone']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.matched_text).toBe('(555) 123-4567');
    });

    it('should detect international phone numbers', () => {
      const content = 'International: +1-555-123-4567';
      const matches = detector.detect(content, ['phone']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('phone');
    });
  });

  // ─── Payment Card Detection ──────────────────────────────────────────────

  describe('payment card detection', () => {
    it('should detect Visa card numbers', () => {
      const content = 'Card: 4111 1111 1111 1111';
      const matches = detector.detect(content, ['payment_card']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('payment_card');
      expect(matches[0]!.confidence).toBeGreaterThanOrEqual(0.90);
    });

    it('should detect Mastercard numbers', () => {
      const content = 'MC: 5500-0000-0000-0004';
      const matches = detector.detect(content, ['payment_card']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('payment_card');
    });

    it('should detect Amex card numbers', () => {
      const content = 'Amex: 3782 822463 10005';
      const matches = detector.detect(content, ['payment_card']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('payment_card');
    });
  });

  // ─── Government ID Detection ─────────────────────────────────────────────

  describe('government ID detection', () => {
    it('should detect US SSN with dashes', () => {
      const content = 'SSN: 123-45-6789';
      const matches = detector.detect(content, ['government_id']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('government_id');
      expect(matches[0]!.matched_text).toBe('123-45-6789');
    });

    it('should detect US SSN with spaces', () => {
      const content = 'Social: 123 45 6789';
      const matches = detector.detect(content, ['government_id']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('government_id');
    });

    it('should detect UK National Insurance numbers', () => {
      const content = 'NI: AB 12 34 56 C';
      const matches = detector.detect(content, ['government_id']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('government_id');
    });
  });

  // ─── Bank Account Detection ──────────────────────────────────────────────

  describe('bank account detection', () => {
    it('should detect IBAN numbers', () => {
      const content = 'IBAN: GB29 NWBK 6016 1331 9268 19';
      const matches = detector.detect(content, ['bank_account']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('bank_account');
    });

    it('should detect routing numbers with label', () => {
      const content = 'Transfer to 021000021 routing number.';
      const matches = detector.detect(content, ['bank_account']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('bank_account');
    });
  });

  // ─── IP Address Detection ────────────────────────────────────────────────

  describe('IP address detection', () => {
    it('should detect IPv4 addresses', () => {
      const content = 'Server at 192.168.1.100 is down.';
      const matches = detector.detect(content, ['ip_address']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('ip_address');
      expect(matches[0]!.matched_text).toBe('192.168.1.100');
    });

    it('should detect multiple IPv4 addresses', () => {
      const content = 'From 10.0.0.1 to 172.16.0.1';
      const matches = detector.detect(content, ['ip_address']);

      expect(matches).toHaveLength(2);
    });

    it('should detect IPv6 addresses', () => {
      const content = 'IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      const matches = detector.detect(content, ['ip_address']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('ip_address');
    });
  });

  // ─── Geolocation Detection ───────────────────────────────────────────────

  describe('geolocation detection', () => {
    it('should detect latitude/longitude coordinates', () => {
      const content = 'Location: 40.7128, -74.0060';
      const matches = detector.detect(content, ['geolocation']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('geolocation');
    });
  });

  // ─── Date of Birth Detection ─────────────────────────────────────────────

  describe('date of birth detection', () => {
    it('should detect DOB with explicit marker', () => {
      const content = 'DOB: 01/15/1990';
      const matches = detector.detect(content, ['date_of_birth']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('date_of_birth');
    });

    it('should detect "date of birth" with ISO format', () => {
      const content = 'Date of birth: 1990-01-15';
      const matches = detector.detect(content, ['date_of_birth']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('date_of_birth');
    });

    it('should detect "born on" with month name', () => {
      const content = 'She was born on January 15, 1990';
      const matches = detector.detect(content, ['date_of_birth']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('date_of_birth');
    });
  });

  // ─── Credential Detection ────────────────────────────────────────────────

  describe('credential detection', () => {
    it('should detect password assignments', () => {
      const content = 'password=MyS3cur3P@ss!';
      const matches = detector.detect(content, ['credential']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('credential');
    });

    it('should detect API key assignments', () => {
      const content = 'api_key: sk_live_abcdef1234567890abcdef';
      const matches = detector.detect(content, ['credential']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('credential');
    });

    it('should detect AWS access keys', () => {
      const content = 'AWS key: AKIAIOSFODNN7EXAMPLE';
      const matches = detector.detect(content, ['credential']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('credential');
      expect(matches[0]!.confidence).toBe(0.99);
    });

    it('should detect bearer token assignments', () => {
      const content = 'bearer: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const matches = detector.detect(content, ['credential']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('credential');
    });
  });

  // ─── Name Detection ──────────────────────────────────────────────────────

  describe('name detection', () => {
    it('should detect names with title prefix', () => {
      const content = 'Signed by Dr. Jane Smith on behalf of the team.';
      const matches = detector.detect(content, ['name']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('name');
      expect(matches[0]!.matched_text).toBe('Dr. Jane Smith');
    });

    it('should detect names with explicit label', () => {
      const content = 'Customer: John Williams';
      const matches = detector.detect(content, ['name']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('name');
    });

    it('should detect names with Mr/Mrs prefix', () => {
      const content = 'Dear Mr. Robert Johnson,';
      const matches = detector.detect(content, ['name']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('name');
    });
  });

  // ─── Address Detection ───────────────────────────────────────────────────

  describe('address detection', () => {
    it('should detect US street addresses', () => {
      const content = 'Ship to 123 Main Street, please.';
      const matches = detector.detect(content, ['address']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('address');
    });

    it('should detect addresses with various street types', () => {
      const content = 'Office at 456 Oak Avenue';
      const matches = detector.detect(content, ['address']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('address');
    });
  });

  // ─── Multi-Category Detection ────────────────────────────────────────────

  describe('multi-category detection', () => {
    it('should detect multiple PII types in one content', () => {
      const content =
        'Contact Dr. Jane Smith at jane.smith@example.com or call 555-123-4567.';
      const matches = detector.detect(content);

      const categories = matches.map((m) => m.category);
      expect(categories).toContain('name');
      expect(categories).toContain('email');
      expect(categories).toContain('phone');
    });

    it('should return empty array for content with no PII', () => {
      const content = 'The weather today is sunny with a high of 72 degrees.';
      const matches = detector.detect(content);

      expect(matches).toHaveLength(0);
    });

    it('should filter by specified categories', () => {
      const content =
        'Email: test@example.com, Phone: 555-123-4567, SSN: 123-45-6789';
      const matches = detector.detect(content, ['email']);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.category).toBe('email');
    });
  });

  // ─── Match Properties ────────────────────────────────────────────────────

  describe('match properties', () => {
    it('should include correct start and end offsets', () => {
      const content = 'Email: test@example.com here';
      const matches = detector.detect(content, ['email']);

      expect(matches).toHaveLength(1);
      const match = matches[0]!;
      expect(content.slice(match.start_offset, match.end_offset)).toBe(
        'test@example.com',
      );
    });

    it('should include confidence scores in [0, 1]', () => {
      const content = 'test@example.com 192.168.1.1 555-123-4567';
      const matches = detector.detect(content);

      for (const match of matches) {
        expect(match.confidence).toBeGreaterThanOrEqual(0);
        expect(match.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should return matches sorted by start_offset', () => {
      const content = 'A: test@a.com B: test@b.com C: test@c.com';
      const matches = detector.detect(content, ['email']);

      for (let i = 1; i < matches.length; i++) {
        expect(matches[i]!.start_offset).toBeGreaterThanOrEqual(
          matches[i - 1]!.start_offset,
        );
      }
    });
  });
});
