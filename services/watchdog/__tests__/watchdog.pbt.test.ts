/**
 * Property-Based Tests for Watchdog_Service
 *
 * Property 95: Watchdog Recursion Limit Enforcement
 * Property 96: Watchdog Timeout Enforcement
 *
 * @see Requirements 53.1, 53.2, 53.5
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { WatchdogService } from '../src/watchdog-service.js';

describe('Watchdog_Service PBT', () => {
  it('Property 95: Watchdog Recursion Limit Enforcement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // Max depth threshold
        fc.integer({ min: 1, max: 30 }), // Candidate depth
        async (maxDepth, candidateDepth) => {
          const auditEvents: any[] = [];
          const mockAuditPublisher = {
            publishAudit: async (event: any) => {
              auditEvents.push(event);
            },
          };

          const service = new WatchdogService({
            idGenerator: { uuid: () => 'uuid-123' },
            clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
            auditPublisher: mockAuditPublisher,
            config: { maxRecursionDepth: maxDepth },
          });

          const operation = vi.fn().mockResolvedValue('success');

          if (candidateDepth > maxDepth) {
            await expect(
              service.executeOperation('agent-1', 'op-1', candidateDepth, 512, operation)
            ).rejects.toThrow(/exceeds maximum limit/);

            expect(operation).not.toHaveBeenCalled();
            expect(auditEvents.length).toBe(1);
            expect(auditEvents[0].severity).toBe('high');
            expect(auditEvents[0].metadata.reason_code).toBe('RECURSION_EXCEEDED');
          } else {
            const result = await service.executeOperation('agent-1', 'op-1', candidateDepth, 512, operation);
            expect(result).toBe('success');
            expect(operation).toHaveBeenCalled();
            expect(auditEvents.length).toBe(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 96: Watchdog Timeout Enforcement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 100 }), // timeout ms
        async (timeoutMs) => {
          const auditEvents: any[] = [];
          const mockAuditPublisher = {
            publishAudit: async (event: any) => {
              auditEvents.push(event);
            },
          };

          const service = new WatchdogService({
            idGenerator: { uuid: () => 'uuid-123' },
            clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
            auditPublisher: mockAuditPublisher,
            config: { defaultTimeoutMs: timeoutMs },
          });

          // An operation that takes longer than timeoutMs
          const slowOperation = () =>
            new Promise<string>((resolve) => setTimeout(() => resolve('done'), timeoutMs * 2));

          await expect(
            service.executeOperation('agent-slow', 'op-slow', 1, 512, slowOperation)
          ).rejects.toThrow(/exceeded timeout limit/);

          expect(auditEvents.length).toBe(1);
          expect(auditEvents[0].severity).toBe('high');
          expect(auditEvents[0].metadata.reason_code).toBe('TIMEOUT');
        }
      ),
      { numRuns: 20 } // Fewer runs since it involves actual sleep/setTimeout
    );
  });

  it('Requirement 53.3: Cycle detection logic works correctly', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 })),
        (nodes) => {
          const service = new WatchdogService({
            idGenerator: { uuid: () => 'uuid-123' },
            clock: { nowISO: () => 'time', nowMs: () => Date.now() },
            auditPublisher: { publishAudit: async () => {} },
          });

          // Test a clear cycle if there are at least 2 nodes
          if (nodes.length >= 2) {
            const uniqueNodes = Array.from(new Set(nodes));
            if (uniqueNodes.length >= 2) {
              const deps: Record<string, string[]> = {};
              // Build cycle: node[0] -> node[1] -> node[0]
              deps[uniqueNodes[0]] = [uniqueNodes[1]];
              deps[uniqueNodes[1]] = [uniqueNodes[0]];
              expect(service.detectCycles(uniqueNodes, deps)).toBe(true);
            }
          }
        }
      )
    );
  });
});
