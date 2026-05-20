/**
 * Property-Based Tests for Reliability Patterns
 *
 * Property 41: Backpressure on Queue Overload
 * Property 42: Durable Persistence Before Acknowledgment
 *
 * @see Requirements 31.3, 31.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { BackpressureQueue, DurableAcknowledgmentProcessor, type DurableStore } from '../src/reliability.js';

describe('Reliability_Patterns PBT', () => {
  it('Property 41: Backpressure on Queue Overload', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // Capacity limit
        fc.integer({ min: 1, max: 30 }), // Number of items to enqueue
        (capacity, itemsCount) => {
          const queue = new BackpressureQueue<number>(capacity);

          if (itemsCount > capacity) {
            // Should successfully enqueue up to capacity
            for (let i = 0; i < capacity; i++) {
              queue.enqueue(i);
            }
            // Enqueuing the (capacity + 1)-th item must reject with RETRY_LATER
            expect(() => queue.enqueue(capacity)).toThrow(/RETRY_LATER/);
            expect(queue.size()).toBe(capacity);
          } else {
            // Should successfully enqueue all items
            for (let i = 0; i < itemsCount; i++) {
              queue.enqueue(i);
            }
            expect(queue.size()).toBe(itemsCount);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 42: Durable Persistence Before Acknowledgment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.string(), payload: fc.string() })),
        async (items) => {
          const persistedItems: any[] = [];
          const ackedItems: any[] = [];

          const mockStore: DurableStore<any> = {
            save: async (item) => {
              // Simulate small network delay
              await new Promise((resolve) => setTimeout(resolve, 1));
              persistedItems.push(item);
            },
          };

          const processor = new DurableAcknowledgmentProcessor<any>(mockStore);

          for (const item of items) {
            await processor.processAndAck(item, async () => {
              // Acknowledgment callback
              // Verify that persistence has already occurred before this ack!
              expect(persistedItems).toContain(item);
              ackedItems.push(item);
            });
          }

          expect(persistedItems.length).toBe(items.length);
          expect(ackedItems.length).toBe(items.length);
        }
      ),
      { numRuns: 50 }
    );
  });
});
