/**
 * Unit tests for SIEMForwardingService.
 *
 * Verifies:
 * - Events are forwarded to tenant-configured SIEM
 * - Events are buffered on forwarding failure
 * - Exponential backoff retry is applied
 * - HIGH alert is emitted when buffer age exceeds 1 hour
 * - No forwarding when tenant has no SIEM configured
 *
 * @see Requirement 21.5 - Forward events to SIEM within 60s at p95
 * @see Requirement 21.6 - Durable buffering with backoff retry and alerting
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AuditEvent } from '@may/types';
import { SIEMForwardingService } from '../src/siem-forwarding-service.js';
import type {
  SIEMForwardingConfig,
  IAlertEmitter,
  ISIEMConfigProvider,
  SIEMAlert,
} from '../src/siem-forwarding-service.js';
import { InMemoryDurableBuffer } from '../src/in-memory-durable-buffer.js';
import type { ISIEMForwarder, SIEMEndpointConfig, ForwardResult } from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: 'evt-001',
    sequence_number: 1,
    chain_hash: 'abc123',
    timestamp: '2024-01-15T10:30:00.000Z',
    tenant_id: 'tenant-1',
    principal_id: 'principal-1',
    source_service: 'Control_Service',
    event_category: 'action.executed',
    severity: 'INFO',
    correlation_id: 'corr-123',
    outcome: 'SUCCESS',
    payload: { action_id: 'act-1' },
    ...overrides,
  };
}

/** Stub SIEM forwarder that can be configured to succeed or fail. */
class StubSIEMForwarder implements ISIEMForwarder {
  public calls: Array<{ events: readonly AuditEvent[]; config: SIEMEndpointConfig }> = [];
  public shouldSucceed = true;
  public statusCode = 200;
  public errorMessage = 'Connection refused';

  async forward(events: readonly AuditEvent[], config: SIEMEndpointConfig): Promise<ForwardResult> {
    this.calls.push({ events, config });
    if (this.shouldSucceed) {
      return {
        success: true,
        status_code: this.statusCode,
        attempted_at: new Date().toISOString(),
      };
    }
    return {
      success: false,
      status_code: 503,
      error: this.errorMessage,
      attempted_at: new Date().toISOString(),
    };
  }
}

/** Stub SIEM config provider. */
class StubSIEMConfigProvider implements ISIEMConfigProvider {
  private readonly configs: Map<string, SIEMEndpointConfig> = new Map();

  addConfig(tenantId: string, config: SIEMEndpointConfig): void {
    this.configs.set(tenantId, config);
  }

  async getConfig(tenantId: string): Promise<SIEMEndpointConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }
}

/** Stub alert emitter that records emitted alerts. */
class StubAlertEmitter implements IAlertEmitter {
  public alerts: SIEMAlert[] = [];

  async emit(alert: SIEMAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

const DEFAULT_SIEM_CONFIG: SIEMEndpointConfig = {
  tenant_id: 'tenant-1',
  endpoint_url: 'https://siem.example.com/events',
  auth_token: 'test-token-123',
};

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('SIEMForwardingService', () => {
  let forwarder: StubSIEMForwarder;
  let buffer: InMemoryDurableBuffer;
  let configProvider: StubSIEMConfigProvider;
  let alertEmitter: StubAlertEmitter;
  let currentTime: number;
  let bufferClock: () => string;
  let service: SIEMForwardingService;

  beforeEach(() => {
    currentTime = new Date('2024-01-15T10:30:00.000Z').getTime();
    bufferClock = () => new Date(currentTime).toISOString();

    forwarder = new StubSIEMForwarder();
    buffer = new InMemoryDurableBuffer(bufferClock);
    configProvider = new StubSIEMConfigProvider();
    alertEmitter = new StubAlertEmitter();

    configProvider.addConfig('tenant-1', DEFAULT_SIEM_CONFIG);

    service = new SIEMForwardingService(
      forwarder,
      buffer,
      configProvider,
      alertEmitter,
      undefined,
      () => currentTime,
    );
  });

  // ─── Direct Forwarding ─────────────────────────────────────────────────

  describe('direct forwarding', () => {
    it('should forward events to the configured SIEM endpoint', async () => {
      const events = [createTestEvent()];
      await service.forwardEvents('tenant-1', events);

      expect(forwarder.calls).toHaveLength(1);
      expect(forwarder.calls[0]!.events).toEqual(events);
      expect(forwarder.calls[0]!.config).toEqual(DEFAULT_SIEM_CONFIG);
    });

    it('should not forward when no events are provided', async () => {
      await service.forwardEvents('tenant-1', []);
      expect(forwarder.calls).toHaveLength(0);
    });

    it('should silently skip when tenant has no SIEM configured', async () => {
      const events = [createTestEvent({ tenant_id: 'tenant-no-siem' })];
      await service.forwardEvents('tenant-no-siem', events);

      expect(forwarder.calls).toHaveLength(0);
      const bufferSize = await buffer.size('tenant-no-siem');
      expect(bufferSize).toBe(0);
    });

    it('should forward multiple events in a single call', async () => {
      const events = [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
        createTestEvent({ event_id: 'evt-003' }),
      ];
      await service.forwardEvents('tenant-1', events);

      expect(forwarder.calls).toHaveLength(1);
      expect(forwarder.calls[0]!.events).toHaveLength(3);
    });

    it('should reset retry state on successful forwarding', async () => {
      // First, cause a failure to create retry state
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);
      expect(service.getRetryState('tenant-1')).toBeDefined();

      // Now succeed
      forwarder.shouldSucceed = true;
      await service.forwardEvents('tenant-1', [createTestEvent({ event_id: 'evt-002' })]);
      expect(service.getRetryState('tenant-1')).toBeUndefined();
    });
  });

  // ─── Buffering on Failure ──────────────────────────────────────────────

  describe('buffering on failure', () => {
    it('should buffer events when forwarding fails', async () => {
      forwarder.shouldSucceed = false;
      const events = [createTestEvent()];
      await service.forwardEvents('tenant-1', events);

      const bufferSize = await buffer.size('tenant-1');
      expect(bufferSize).toBe(1);
    });

    it('should buffer all events from a failed batch', async () => {
      forwarder.shouldSucceed = false;
      const events = [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
        createTestEvent({ event_id: 'evt-003' }),
      ];
      await service.forwardEvents('tenant-1', events);

      const bufferSize = await buffer.size('tenant-1');
      expect(bufferSize).toBe(3);
    });

    it('should initialize retry state on first failure', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      const retryState = service.getRetryState('tenant-1');
      expect(retryState).toBeDefined();
      expect(retryState!.attempt_count).toBe(1);
    });
  });

  // ─── Exponential Backoff ───────────────────────────────────────────────

  describe('exponential backoff', () => {
    it('should compute correct retry delay for attempt 1', () => {
      const delay = service.computeRetryDelay(1);
      // initial_retry_delay_ms * 2^(1-1) = 1000 * 1 = 1000
      expect(delay).toBe(1000);
    });

    it('should compute correct retry delay for attempt 2', () => {
      const delay = service.computeRetryDelay(2);
      // 1000 * 2^(2-1) = 1000 * 2 = 2000
      expect(delay).toBe(2000);
    });

    it('should compute correct retry delay for attempt 3', () => {
      const delay = service.computeRetryDelay(3);
      // 1000 * 2^(3-1) = 1000 * 4 = 4000
      expect(delay).toBe(4000);
    });

    it('should cap retry delay at max_retry_delay_ms', () => {
      const delay = service.computeRetryDelay(20);
      // Would be 1000 * 2^19 = very large, capped at 60000
      expect(delay).toBe(60000);
    });

    it('should respect custom backoff configuration', () => {
      const customService = new SIEMForwardingService(
        forwarder,
        buffer,
        configProvider,
        alertEmitter,
        {
          initial_retry_delay_ms: 500,
          backoff_multiplier: 3,
          max_retry_delay_ms: 30000,
        },
        () => currentTime,
      );

      // 500 * 3^(2-1) = 500 * 3 = 1500
      expect(customService.computeRetryDelay(2)).toBe(1500);
      // 500 * 3^(3-1) = 500 * 9 = 4500
      expect(customService.computeRetryDelay(3)).toBe(4500);
    });

    it('should not retry before backoff delay has elapsed', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // Try to process retry buffer immediately (before delay)
      forwarder.shouldSucceed = true;
      const result = await service.processRetryBuffer('tenant-1');

      expect(result).toBe(false);
      // Forwarder should not have been called again (only the initial call)
      expect(forwarder.calls).toHaveLength(1);
    });

    it('should retry after backoff delay has elapsed', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // Advance time past the first retry delay (1000ms)
      currentTime += 1001;
      forwarder.shouldSucceed = true;

      const result = await service.processRetryBuffer('tenant-1');
      expect(result).toBe(true);
      // Should have called forwarder again
      expect(forwarder.calls).toHaveLength(2);
    });

    it('should advance backoff on repeated failures', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // First retry attempt (after 1000ms delay)
      currentTime += 1001;
      await service.processRetryBuffer('tenant-1');

      const retryState = service.getRetryState('tenant-1');
      expect(retryState!.attempt_count).toBe(2);
      // Next retry should be at currentTime + 2000ms
      expect(retryState!.next_retry_at).toBe(currentTime + 2000);
    });
  });

  // ─── Buffer Age Alert ──────────────────────────────────────────────────

  describe('buffer age alert', () => {
    it('should emit HIGH alert when buffer age exceeds 1 hour', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // Advance time past 1 hour
      currentTime += 3_600_001;

      // Process retry buffer (which checks age)
      // Need to also advance past retry delay
      await service.processRetryBuffer('tenant-1');

      expect(alertEmitter.alerts).toHaveLength(1);
      expect(alertEmitter.alerts[0]!.severity).toBe('HIGH');
      expect(alertEmitter.alerts[0]!.tenant_id).toBe('tenant-1');
      expect(alertEmitter.alerts[0]!.buffer_age_ms).toBeGreaterThanOrEqual(3_600_000);
      expect(alertEmitter.alerts[0]!.buffered_count).toBe(1);
    });

    it('should not emit alert when buffer age is below threshold', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // Advance time to 30 minutes (below 1 hour threshold)
      currentTime += 1_800_000;

      await service.processRetryBuffer('tenant-1');

      expect(alertEmitter.alerts).toHaveLength(0);
    });

    it('should include buffer count in alert', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [
        createTestEvent({ event_id: 'evt-001' }),
        createTestEvent({ event_id: 'evt-002' }),
        createTestEvent({ event_id: 'evt-003' }),
      ]);

      // Advance time past 1 hour
      currentTime += 3_600_001;
      await service.processRetryBuffer('tenant-1');

      expect(alertEmitter.alerts[0]!.buffered_count).toBe(3);
    });

    it('should emit alert with custom threshold', async () => {
      const customService = new SIEMForwardingService(
        forwarder,
        buffer,
        configProvider,
        alertEmitter,
        { buffer_age_alert_threshold_ms: 1_800_000 }, // 30 minutes
        () => currentTime,
      );

      forwarder.shouldSucceed = false;
      await customService.forwardEvents('tenant-1', [createTestEvent()]);

      // Advance time past 30 minutes
      currentTime += 1_800_001;
      await customService.processRetryBuffer('tenant-1');

      expect(alertEmitter.alerts).toHaveLength(1);
      expect(alertEmitter.alerts[0]!.severity).toBe('HIGH');
    });
  });

  // ─── Retry Buffer Processing ───────────────────────────────────────────

  describe('retry buffer processing', () => {
    it('should return true when buffer is empty', async () => {
      const result = await service.processRetryBuffer('tenant-1');
      expect(result).toBe(true);
    });

    it('should remove entries from buffer on successful retry', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // Advance time and succeed
      currentTime += 1001;
      forwarder.shouldSucceed = true;
      await service.processRetryBuffer('tenant-1');

      const bufferSize = await buffer.size('tenant-1');
      expect(bufferSize).toBe(0);
    });

    it('should mark entries as attempted on retry', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      // Advance time past retry delay
      currentTime += 1001;
      await service.processRetryBuffer('tenant-1');

      // Peek at buffer - entries should have attempt_count incremented
      const entries = await buffer.peek('tenant-1', 10);
      expect(entries[0]!.attempt_count).toBe(1);
    });

    it('should clear retry state when buffer becomes empty', async () => {
      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);

      currentTime += 1001;
      forwarder.shouldSucceed = true;
      await service.processRetryBuffer('tenant-1');

      expect(service.getRetryState('tenant-1')).toBeUndefined();
    });

    it('should return false when no SIEM config exists for tenant', async () => {
      // Buffer events manually
      await buffer.enqueue('tenant-no-siem', [createTestEvent()]);

      const result = await service.processRetryBuffer('tenant-no-siem');
      expect(result).toBe(false);
    });

    it('should process events in batches respecting batch_size', async () => {
      const batchService = new SIEMForwardingService(
        forwarder,
        buffer,
        configProvider,
        alertEmitter,
        { batch_size: 2 },
        () => currentTime,
      );

      // Buffer 5 events directly
      const events = Array.from({ length: 5 }, (_, i) =>
        createTestEvent({ event_id: `evt-${i}` }),
      );
      await buffer.enqueue('tenant-1', events);

      // Initialize retry state so processRetryBuffer will proceed
      forwarder.shouldSucceed = false;
      await batchService.forwardEvents('tenant-1', [createTestEvent({ event_id: 'evt-trigger' })]);

      currentTime += 1001;
      forwarder.shouldSucceed = true;
      await batchService.processRetryBuffer('tenant-1');

      // Should have forwarded only batch_size (2) events from the peek
      // The last forwarder call should have 2 events
      const lastCall = forwarder.calls[forwarder.calls.length - 1]!;
      expect(lastCall.events.length).toBeLessThanOrEqual(2);
    });
  });

  // ─── Tenant Isolation ──────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('should maintain separate buffers per tenant', async () => {
      configProvider.addConfig('tenant-2', {
        tenant_id: 'tenant-2',
        endpoint_url: 'https://siem2.example.com/events',
        auth_token: 'token-2',
      });

      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent({ tenant_id: 'tenant-1' })]);
      await service.forwardEvents('tenant-2', [
        createTestEvent({ tenant_id: 'tenant-2', event_id: 'evt-t2-1' }),
        createTestEvent({ tenant_id: 'tenant-2', event_id: 'evt-t2-2' }),
      ]);

      const size1 = await buffer.size('tenant-1');
      const size2 = await buffer.size('tenant-2');
      expect(size1).toBe(1);
      expect(size2).toBe(2);
    });

    it('should maintain separate retry states per tenant', async () => {
      configProvider.addConfig('tenant-2', {
        tenant_id: 'tenant-2',
        endpoint_url: 'https://siem2.example.com/events',
        auth_token: 'token-2',
      });

      forwarder.shouldSucceed = false;
      await service.forwardEvents('tenant-1', [createTestEvent()]);
      await service.forwardEvents('tenant-2', [createTestEvent({ tenant_id: 'tenant-2' })]);

      const state1 = service.getRetryState('tenant-1');
      const state2 = service.getRetryState('tenant-2');
      expect(state1).toBeDefined();
      expect(state2).toBeDefined();
      expect(state1!.attempt_count).toBe(1);
      expect(state2!.attempt_count).toBe(1);
    });
  });
});
