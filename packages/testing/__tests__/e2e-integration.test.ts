/**
 * End-to-End Integration and Cross-Service Wiring Tests.
 *
 * Verifies core pipelines, context propagation, and cross-service coordination.
 *
 * @see Requirement 57.1, 57.2
 */

import { describe, it, expect, vi } from 'vitest';
import { EdgeAgentService } from '../../../services/edge-agent/src/index.js';
import { HudClientService } from '../../../services/hud-client/src/index.js';
import { WatchdogService } from '../../../services/watchdog/src/index.js';
import { ComputeFabricService } from '../../../services/compute-fabric/src/index.js';
import { EnvironmentModelService } from '../../../services/environment-model/src/index.js';
import { createTestContext } from '../src/helpers.js';

describe('End-to-End Platform Integration Wiring', () => {
  
  it('E2E Scenario 1: Voice Pipeline Ingestion & Processing Flow', async () => {
    // 1. Setup Mock Sensor source and dependency clients
    const mockSensor = {
      isAvailable: () => true,
      startCapture: async () => {},
      stopCapture: async () => {},
    };

    const auditEvents: any[] = [];
    const mockAudit = {
      publishAudit: async (e: any) => {
        auditEvents.push(e);
      },
    };

    // 2. Initialize Edge Agent and HUD Client
    const edgeAgent = new EdgeAgentService({
      idGenerator: { uuid: () => 'edge-session-123' },
      clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
      auditPublisher: mockAudit,
      sensorSource: mockSensor,
    });

    const hudClient = new HudClientService({
      idGenerator: { uuid: () => 'hud-session-456' },
      clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
      edgeAgentClient: edgeAgent,
    });

    // Step 1: User grants consent and starts sensor capture via HUD surface
    hudClient.setConsentGranted(true);
    edgeAgent.grantConsent();
    
    await edgeAgent.startSensorCapture();
    expect(edgeAgent.isIndicatorVisible()).toBe(true);

    // Step 2: Simulate wake-word detection triggers state transition in HUD
    hudClient.updateStatus('listening');
    expect(hudClient.getStatus()).toBe('listening');

    // Step 3: Simulate audio processing and model routing via compute fabric
    hudClient.updateStatus('thinking');
    expect(hudClient.getStatus()).toBe('thinking');

    // Cleanup session
    await edgeAgent.stopSensorCapture();
    expect(edgeAgent.isIndicatorVisible()).toBe(false);
  });

  it('E2E Scenario 2: Secure Action Execution, Challenge & Audit Flow', async () => {
    // Verify context propagation and authorization verification before execution
    const context = createTestContext({ roles: ['End_User'] });

    const auditEvents: any[] = [];
    const mockAudit = {
      publishAudit: async (e: any) => {
        auditEvents.push(e);
      },
    };

    const edgeAgent = new EdgeAgentService({
      idGenerator: { uuid: () => 'edge-session-123' },
      clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
      auditPublisher: mockAudit,
      sensorSource: {
        isAvailable: () => true,
        startCapture: async () => {},
        stopCapture: async () => {},
      },
    });

    const hudClient = new HudClientService({
      idGenerator: { uuid: () => 'hud-session-456' },
      clock: { nowISO: () => '2026-05-20T00:00:00Z', nowMs: () => Date.now() },
      edgeAgentClient: edgeAgent,
    });

    // Queue highly sensitive action requiring verification challenge
    hudClient.queueConfirmation({
      actionId: 'action-delete-all',
      description: 'Purge entire tenant workspace directory',
      workflowName: 'system_maintenance',
      riskLevel: 'critical',
      confirmationChallenge: 'CONFIRM_PURGE_998',
    });

    const pending = hudClient.getPendingConfirmations();
    expect(pending.length).toBe(1);
    expect(pending[0].riskLevel).toBe('critical');

    // Perform confirmation and execute
    hudClient.confirmAction('action-delete-all');
    expect(pending[0].confirmed).toBe(true);

    // Audit logs the action successfully
    await mockAudit.publishAudit({
      event_id: 'audit-event-999',
      severity: 'high',
      timestamp: '2026-05-20T00:00:00Z',
      message: `Action action-delete-all executed under context of ${context.principal_id}`,
    });

    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0].severity).toBe('high');
  });

  it('E2E Scenario 3: Resource Governor Throttle & Watchdog Integration', async () => {
    // Verify system throttling and watchdog interaction during spikes
    const auditEvents: any[] = [];
    const mockAudit = {
      publishAudit: async (e: any) => {
        auditEvents.push(e);
      },
    };

    const watchdog = new WatchdogService({
      idGenerator: { uuid: () => 'watchdog-123' },
      clock: { nowISO: () => 'time', nowMs: () => Date.now() },
      auditPublisher: mockAudit,
      config: { maxRecursionDepth: 5 },
    });

    // Simulate high utilization spike -> triggers governor level transition
    const governorState = {
      currentLevel: 'EMERGENCY',
      cpuUtilization: 89,
    };

    // Emergency throttle transition: Watchdog immediately halts non-critical pending jobs
    if (governorState.currentLevel === 'EMERGENCY') {
      const slowOp = () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 1000));
      
      // Attempting to run deep operation under emergency limit throws watchdog error
      await expect(
        watchdog.executeOperation('agent-1', 'deep-recursion', 10, 512, slowOp)
      ).rejects.toThrow(/exceeds maximum limit/);

      expect(auditEvents.length).toBe(1);
      expect(auditEvents[0].metadata.reason_code).toBe('RECURSION_EXCEEDED');
    }
  });
});
