/**
 * Property-Based Tests for Resource_Governor_Service
 *
 * Property 92: Throttle_Level Valid Set
 * Property 93: Throttle_Level Hysteresis
 * Property 94: Emergency Throttle on Critical Resources
 *
 * @see Requirements 52.2, 52.3, 52.6
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { ResourceGovernorService } from '../src/resource-governor-service.js';

describe('Resource_Governor_Service PBT', () => {
  it('Property 92, 93, 94: Throttle Logic and Hysteresis', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }), // initial CPU
        fc.integer({ min: 0, max: 100 }), // initial RAM
        fc.integer({ min: 0, max: 100 }), // next CPU
        fc.integer({ min: 0, max: 100 }), // next RAM
        async (cpu1, ram1, cpu2, ram2) => {
          let currentCpu = cpu1;
          let currentRam = ram1;

          const mockPublisher = { publishThrottleLevel: vi.fn() };
          const mockTelemetry = { publishTelemetry: vi.fn() };
          const mockMonitor = {
            getCPUUsage: async () => currentCpu,
            getRAMUsage: async () => currentRam,
            getGPUUsage: async () => undefined,
            getBatteryLevel: async () => undefined,
            getPowerState: async () => 'ac' as const,
            getThermalState: async () => 'nominal' as const,
            enforcePlatformCPUCeiling: vi.fn(),
          };

          const service = new ResourceGovernorService({
            idGenerator: { uuid: () => 'id' },
            clock: { nowISO: () => 'time', nowMs: () => 1 },
            auditPublisher: { publishAudit: vi.fn() },
            telemetryPublisher: mockTelemetry,
            monitor: mockMonitor,
            publisher: mockPublisher,
            config: { hysteresis_margin: 5 }, // strict 5% margin
          });

          // First eval
          await service.evaluateResources();
          const level1 = service.getCurrentLevel();
          
          // Property 92: Valid set
          expect(['NORMAL', 'REDUCED', 'MINIMAL', 'EMERGENCY']).toContain(level1);
          
          // Property 94: Emergency Throttle
          if (cpu1 >= 85 || ram1 >= 88) {
            expect(level1).toBe('EMERGENCY');
          }

          // Second eval
          currentCpu = cpu2;
          currentRam = ram2;
          await service.evaluateResources();
          const level2 = service.getCurrentLevel();

          // Property 93: Hysteresis
          // If level1 was EMERGENCY, we only drop to MINIMAL/NORMAL if BOTH cpu/ram drop below emergency_threshold - margin
          if (level1 === 'EMERGENCY' && level2 !== 'EMERGENCY') {
            expect(cpu2).toBeLessThanOrEqual(85 - 5);
            expect(ram2).toBeLessThanOrEqual(88 - 5);
          }

          // Escalation ignores hysteresis
          if (cpu2 >= 85 || ram2 >= 88) {
            expect(level2).toBe('EMERGENCY');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
