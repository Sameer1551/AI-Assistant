/**
 * @module reliability
 * Cross-cutting reliability patterns: timeouts, circuit breakers, backpressure, idempotency, and durable persistence.
 *
 * @see Requirements 31.1–31.6, Properties 41, 42
 */

/**
 * Requirement 31.1: Timeouts on all outbound network/dependency calls.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Requirement 31.2: Circuit Breaker on outbound dependencies.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failureCount: number = 0;
  private lastStateTransitionTime: number = Date.now();

  constructor(
    private readonly failureThreshold: number = 3,
    private readonly cooldownMs: number = 5000
  ) {}

  getState(): BreakerState {
    this.checkCooldown();
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkCooldown();

    if (this.state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failureCount = 0;
      this.lastStateTransitionTime = Date.now();
    }
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.lastStateTransitionTime = Date.now();
    } else if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.lastStateTransitionTime = Date.now();
    }
  }

  private checkCooldown(): void {
    if (this.state === 'OPEN' && Date.now() - this.lastStateTransitionTime > this.cooldownMs) {
      this.state = 'HALF_OPEN';
      this.lastStateTransitionTime = Date.now();
    }
  }
}

/**
 * Requirement 31.3 / Property 41: Backpressure on Queue Overload.
 */
export class BackpressureQueue<T> {
  private queue: T[] = [];

  constructor(private readonly maxCapacity: number) {}

  enqueue(item: T): void {
    if (this.queue.length >= this.maxCapacity) {
      throw new Error('RETRY_LATER: Ingress queue overloaded');
    }
    this.queue.push(item);
  }

  dequeue(): T | undefined {
    return this.queue.shift();
  }

  size(): number {
    return this.queue.length;
  }
}

/**
 * Requirement 31.4 / Property 42: Durable Persistence Before Acknowledgment.
 */
export interface DurableStore<T> {
  save(item: T): Promise<void>;
}

export class DurableAcknowledgmentProcessor<T> {
  constructor(private readonly dbStore: DurableStore<T>) {}

  async processAndAck(item: T, ackCallback: () => Promise<void>): Promise<void> {
    // 1. Persist to durable store first
    await this.dbStore.save(item);
    
    // 2. Acknowledge after successful persistence
    await ackCallback();
  }
}

/**
 * Requirement 31.5: Idempotency Keys on state-changing APIs.
 */
export class IdempotencyRegistry<TResponse> {
  private readonly registry = new Map<string, { response: TResponse; timestamp: number }>();

  constructor(private readonly ttlMs: number = 3600000) {} // Default 1 hour TTL

  has(key: string): boolean {
    const entry = this.registry.get(key);
    if (!entry) return false;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.registry.delete(key);
      return false;
    }
    return true;
  }

  get(key: string): TResponse | undefined {
    if (this.has(key)) {
      return this.registry.get(key)?.response;
    }
    return undefined;
  }

  register(key: string, response: TResponse): void {
    this.registry.set(key, {
      response,
      timestamp: Date.now(),
    });
  }
}
