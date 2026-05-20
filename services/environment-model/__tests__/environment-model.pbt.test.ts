/**
 * Property-Based Tests for Environment_Model_Service
 *
 * Property 99: Environment Classification Valid Set
 * Property 100: Environment Significant Change Event
 *
 * @see Requirements 55.3, 55.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EnvironmentModelService } from '../src/environment-model-service.js';
import type { EnvironmentChangeEvent } from '@may/types';

describe('Environment_Model_Service PBT', () => {
  it('Property 99: Environment Classification Valid Set', () => {
    fc.assert(
      fc.property(
        fc.record({
          power_state: fc.constantFrom('ac', 'battery', 'unknown') as fc.Arbitrary<'ac' | 'battery' | 'unknown'>,
          monitor_count: fc.integer({ min: 0, max: 10 }),
          internet_connectivity: fc.constantFrom('high_speed', 'low_speed', 'offline') as fc.Arbitrary<'high_speed' | 'low_speed' | 'offline'>,
        }),
        (params) => {
          const service = new EnvironmentModelService({
            idGenerator: { uuid: () => 'uuid-123' },
            clock: { nowISO: () => 'time', nowMs: () => Date.now() },
            publisher: {
              publishChangeEvent: async () => {},
              publishToResourceGovernor: async () => {},
            },
          });

          const physicalEnv = service.classifyPhysicalEnvironment(params);
          expect(['home_office', 'mobile', 'unknown']).toContain(physicalEnv);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 100: Environment Significant Change Event', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('ac', 'battery', 'unknown') as fc.Arbitrary<'ac' | 'battery' | 'unknown'>,
        fc.constantFrom('ac', 'battery', 'unknown') as fc.Arbitrary<'ac' | 'battery' | 'unknown'>,
        fc.constantFrom('high_speed', 'low_speed', 'offline') as fc.Arbitrary<'high_speed' | 'low_speed' | 'offline'>,
        fc.constantFrom('high_speed', 'low_speed', 'offline') as fc.Arbitrary<'high_speed' | 'low_speed' | 'offline'>,
        async (power1, power2, conn1, conn2) => {
          const changeEvents: EnvironmentChangeEvent[] = [];
          const rgEvents: EnvironmentChangeEvent[] = [];

          const service = new EnvironmentModelService({
            idGenerator: { uuid: () => 'uuid-event' },
            clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
            publisher: {
              publishChangeEvent: async (e) => {
                changeEvents.push(e);
              },
              publishToResourceGovernor: async (e) => {
                rgEvents.push(e);
              },
            },
          });

          // State 1
          await service.updateState({
            tenant_id: 'tenant-1',
            principal_id: 'user-1',
            hardware_tier: 'mid',
            gpu_available: true,
            power_state: power1,
            thermal_state: 'nominal',
            internet_connectivity: conn1,
            monitor_count: 2,
          });

          // State 2
          await service.updateState({
            tenant_id: 'tenant-1',
            principal_id: 'user-1',
            hardware_tier: 'mid',
            gpu_available: true,
            power_state: power2,
            thermal_state: 'nominal',
            internet_connectivity: conn2,
            monitor_count: 2,
          });

          const expectedChanges = [];
          if (power1 !== power2) expectedChanges.push('power_state');
          if (conn1 !== conn2) expectedChanges.push('internet_connectivity');

          // Check that all changed fields triggered standard and resource governor events immediately
          for (const field of expectedChanges) {
            const matchedStandard = changeEvents.find(e => e.change_type === `${field}_change`);
            const matchedRg = rgEvents.find(e => e.change_type === `${field}_change`);
            expect(matchedStandard).toBeDefined();
            expect(matchedRg).toBeDefined();
            expect(matchedStandard?.previous_value).toBe(field === 'power_state' ? power1 : conn1);
            expect(matchedStandard?.new_value).toBe(field === 'power_state' ? power2 : conn2);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
