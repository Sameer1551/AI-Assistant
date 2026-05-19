/**
 * @module golden-signal-computer
 * GoldenSignalComputer — computes rate, error rate, latency percentiles, and saturation per service.
 *
 * Maintains a sliding window of request observations and computes the four
 * golden signals (rate, errors, latency, saturation) for each service.
 *
 * @see Requirement 17.4 - Golden signals per service
 */

import type {
  IGoldenSignalComputer,
  GoldenSignals,
  SaturationIndicators,
} from './interfaces/index.js';

/**
 * A single request observation for golden signal computation.
 */
interface RequestObservation {
  readonly timestamp: number;
  readonly durationMs: number;
  readonly isError: boolean;
}

/** Default sliding window duration: 5 minutes in milliseconds. */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * GoldenSignalComputer implementation.
 *
 * Maintains per-service sliding windows of request observations
 * and computes golden signals on demand.
 */
export class GoldenSignalComputer implements IGoldenSignalComputer {
  private readonly observations = new Map<string, RequestObservation[]>();
  private readonly saturationData = new Map<string, SaturationIndicators>();
  private readonly windowMs: number;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  recordRequest(serviceName: string, durationMs: number, isError: boolean): void {
    if (!this.observations.has(serviceName)) {
      this.observations.set(serviceName, []);
    }

    const observations = this.observations.get(serviceName)!;
    observations.push({
      timestamp: Date.now(),
      durationMs,
      isError,
    });

    // Prune old observations outside the window
    this.pruneObservations(serviceName);
  }

  recordSaturation(serviceName: string, saturation: SaturationIndicators): void {
    this.saturationData.set(serviceName, saturation);
  }

  compute(serviceName: string): GoldenSignals {
    this.pruneObservations(serviceName);

    const observations = this.observations.get(serviceName) ?? [];
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Compute rate (requests per second)
    const windowSeconds = this.windowMs / 1000;
    const rate = observations.length / windowSeconds;

    // Compute error rate
    const errorCount = observations.filter(o => o.isError).length;
    const errorRate = observations.length > 0 ? errorCount / observations.length : 0;

    // Compute latency percentiles
    const durations = observations.map(o => o.durationMs).sort((a, b) => a - b);
    const latencyP50 = this.percentile(durations, 50);
    const latencyP95 = this.percentile(durations, 95);
    const latencyP99 = this.percentile(durations, 99);

    // Get saturation (default to zeros if not recorded)
    const saturation = this.saturationData.get(serviceName) ?? {
      cpu: 0,
      memory: 0,
      queue_depth: 0,
    };

    return {
      service_name: serviceName,
      rate,
      error_rate: errorRate,
      latency_p50: latencyP50,
      latency_p95: latencyP95,
      latency_p99: latencyP99,
      saturation,
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(now).toISOString(),
    };
  }

  /**
   * Computes a percentile value from a sorted array of numbers.
   * Uses the nearest-rank method.
   */
  private percentile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0]!;

    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
  }

  /**
   * Removes observations outside the sliding window for a service.
   */
  private pruneObservations(serviceName: string): void {
    const observations = this.observations.get(serviceName);
    if (!observations) return;

    const cutoff = Date.now() - this.windowMs;
    const pruned = observations.filter(o => o.timestamp >= cutoff);
    this.observations.set(serviceName, pruned);
  }
}
