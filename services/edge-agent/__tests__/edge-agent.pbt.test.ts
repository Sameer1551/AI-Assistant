/**
 * Property-Based Tests for Edge_Agent_Service
 *
 * Property 9: Sensor Consent Gating
 * Property 10: Consent Revocation Enforcement
 * Property 11: Offline_Mode Resource Boundary
 *
 * @see Requirements 23.1, 23.4, 23.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EdgeAgentService } from '../src/edge-agent-service.js';

describe('Edge_Agent_Service PBT', () => {
  it('Property 9: Sensor Consent Gating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // whether consent is granted
        async (consentGranted) => {
          const mockSensor = {
            isAvailable: () => true,
            startCapture: async () => {},
            stopCapture: async () => {},
          };

          const agent = new EdgeAgentService({
            idGenerator: { uuid: () => 'uuid-1' },
            clock: { nowISO: () => 'time', nowMs: () => Date.now() },
            auditPublisher: { publishAudit: async () => {} },
            sensorSource: mockSensor,
          });

          if (consentGranted) {
            agent.grantConsent();
            const started = await agent.startSensorCapture();
            expect(started).toBe(true);
            expect(agent.isIndicatorVisible()).toBe(true);
          } else {
            await expect(agent.startSensorCapture()).rejects.toThrow(/Consent not granted/);
            expect(agent.isIndicatorVisible()).toBe(false);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 10: Consent Revocation Enforcement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // amount of active sensor data in buffer
        async (bufferSize) => {
          const auditEvents: any[] = [];
          const mockSensor = {
            isAvailable: () => true,
            startCapture: async () => {},
            stopCapture: async () => {},
          };

          const agent = new EdgeAgentService({
            idGenerator: { uuid: () => 'uuid-2' },
            clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
            auditPublisher: {
              publishAudit: async (e) => {
                auditEvents.push(e);
              },
            },
            sensorSource: mockSensor,
          });

          agent.grantConsent();
          await agent.startSensorCapture();

          // Push some mock sensor data
          for (let i = 0; i < bufferSize; i++) {
            agent.pushSensorData({ val: i });
          }

          expect(agent.getSensorBuffersCount()).toBe(bufferSize);

          // Revoke consent
          await agent.revokeConsent();

          // Assertions
          expect(agent.isIndicatorVisible()).toBe(false);
          expect(agent.getSensorBuffersCount()).toBe(0); // Discarded
          expect(auditEvents.length).toBe(1);
          expect(auditEvents[0].severity).toBe('high');
          expect(auditEvents[0].metadata.elapsed_time_ms).toBeLessThanOrEqual(5000); // within 5s limit
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 11: Offline_Mode Resource Boundary', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // offlineMode state
        async (isOffline) => {
          const agent = new EdgeAgentService({
            idGenerator: { uuid: () => 'uuid-3' },
            clock: { nowISO: () => 'time', nowMs: () => Date.now() },
            auditPublisher: { publishAudit: async () => {} },
            sensorSource: {
              isAvailable: () => true,
              startCapture: async () => {},
              stopCapture: async () => {},
            },
          });

          agent.grantConsent();

          if (isOffline) {
            agent.enableOfflineMode();
            expect(agent.isOfflineMode()).toBe(true);
            expect(agent.getOfflineSignature()).toContain('offline_signed');

            // Ingest data and verify local-only isolated boundary
            agent.pushSensorData({ sound: 'wave' });
            // Should tag with isolated boundary marker
            expect(agent.getSensorBuffersCount()).toBe(1);
          } else {
            agent.disableOfflineMode();
            expect(agent.isOfflineMode()).toBe(false);
            expect(agent.getOfflineSignature()).toBeNull();
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
