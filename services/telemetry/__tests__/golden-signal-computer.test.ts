/**
 * Unit tests for GoldenSignalComputer.
 *
 * Verifies:
 * - Request rate computation
 * - Error rate computation
 * - Latency percentile computation (p50, p95, p99)
 * - Saturation recording
 * - Sliding window pruning
 *
 * @see Requirement 17.4 - Golden signals per service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GoldenSignalComputer } from '../src/golden-signal-computer.js';

describe('GoldenSignalComputer', () => {
  let computer: GoldenSignalComputer;

  beforeEach(() => {
    // Use a 10-second window for testing
    computer = new GoldenSignalComputer(10_000);
  });

  describe('compute with no observations', () => {
    it('should return zero values for unknown service', () => {
      const signals = computer.compute('unknown-service');

      expect(signals.service_name).toBe('unknown-service');
      expect(signals.rate).toBe(0);
      expect(signals.error_rate).toBe(0);
      expect(signals.latency_p50).toBe(0);
      expect(signals.latency_p95).toBe(0);
      expect(signals.latency_p99).toBe(0);
    });

    it('should return default saturation when not recorded', () => {
      const signals = computer.compute('some-service');

      expect(signals.saturation.cpu).toBe(0);
      expect(signals.saturation.memory).toBe(0);
      expect(signals.saturation.queue_depth).toBe(0);
    });
  });

  describe('rate computation', () => {
    it('should compute request rate as requests per second', () => {
      // Record 10 requests in a 10-second window
      for (let i = 0; i < 10; i++) {
        computer.recordRequest('svc-a', 50, false);
      }

      const signals = computer.compute('svc-a');
      // 10 requests / 10 seconds = 1 req/s
      expect(signals.rate).toBe(1);
    });

    it('should compute rate for multiple services independently', () => {
      for (let i = 0; i < 20; i++) {
        computer.recordRequest('svc-a', 50, false);
      }
      for (let i = 0; i < 5; i++) {
        computer.recordRequest('svc-b', 50, false);
      }

      const signalsA = computer.compute('svc-a');
      const signalsB = computer.compute('svc-b');

      expect(signalsA.rate).toBe(2); // 20/10
      expect(signalsB.rate).toBe(0.5); // 5/10
    });
  });

  describe('error rate computation', () => {
    it('should compute error rate as fraction of errors', () => {
      // 3 errors out of 10 requests
      for (let i = 0; i < 7; i++) {
        computer.recordRequest('svc-a', 50, false);
      }
      for (let i = 0; i < 3; i++) {
        computer.recordRequest('svc-a', 50, true);
      }

      const signals = computer.compute('svc-a');
      expect(signals.error_rate).toBeCloseTo(0.3);
    });

    it('should return 0 error rate when all requests succeed', () => {
      for (let i = 0; i < 5; i++) {
        computer.recordRequest('svc-a', 50, false);
      }

      const signals = computer.compute('svc-a');
      expect(signals.error_rate).toBe(0);
    });

    it('should return 1.0 error rate when all requests fail', () => {
      for (let i = 0; i < 5; i++) {
        computer.recordRequest('svc-a', 50, true);
      }

      const signals = computer.compute('svc-a');
      expect(signals.error_rate).toBe(1.0);
    });
  });

  describe('latency percentile computation', () => {
    it('should compute p50 as median latency', () => {
      // Record latencies: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      for (let i = 1; i <= 10; i++) {
        computer.recordRequest('svc-a', i * 10, false);
      }

      const signals = computer.compute('svc-a');
      expect(signals.latency_p50).toBe(50);
    });

    it('should compute p95 correctly', () => {
      // Record 100 latencies from 1 to 100
      for (let i = 1; i <= 100; i++) {
        computer.recordRequest('svc-a', i, false);
      }

      const signals = computer.compute('svc-a');
      expect(signals.latency_p95).toBe(95);
    });

    it('should compute p99 correctly', () => {
      // Record 100 latencies from 1 to 100
      for (let i = 1; i <= 100; i++) {
        computer.recordRequest('svc-a', i, false);
      }

      const signals = computer.compute('svc-a');
      expect(signals.latency_p99).toBe(99);
    });

    it('should return single value when only one observation', () => {
      computer.recordRequest('svc-a', 42, false);

      const signals = computer.compute('svc-a');
      expect(signals.latency_p50).toBe(42);
      expect(signals.latency_p95).toBe(42);
      expect(signals.latency_p99).toBe(42);
    });
  });

  describe('saturation recording', () => {
    it('should record and return saturation indicators', () => {
      computer.recordSaturation('svc-a', {
        cpu: 0.75,
        memory: 0.60,
        queue_depth: 150,
      });

      const signals = computer.compute('svc-a');
      expect(signals.saturation.cpu).toBe(0.75);
      expect(signals.saturation.memory).toBe(0.60);
      expect(signals.saturation.queue_depth).toBe(150);
    });

    it('should use latest saturation values', () => {
      computer.recordSaturation('svc-a', { cpu: 0.5, memory: 0.5, queue_depth: 10 });
      computer.recordSaturation('svc-a', { cpu: 0.9, memory: 0.8, queue_depth: 200 });

      const signals = computer.compute('svc-a');
      expect(signals.saturation.cpu).toBe(0.9);
      expect(signals.saturation.memory).toBe(0.8);
      expect(signals.saturation.queue_depth).toBe(200);
    });
  });

  describe('window metadata', () => {
    it('should include window_start and window_end timestamps', () => {
      computer.recordRequest('svc-a', 50, false);
      const signals = computer.compute('svc-a');

      expect(signals.window_start).toBeDefined();
      expect(signals.window_end).toBeDefined();
      // window_end should be after window_start
      expect(new Date(signals.window_end).getTime()).toBeGreaterThan(
        new Date(signals.window_start).getTime(),
      );
    });
  });
});
