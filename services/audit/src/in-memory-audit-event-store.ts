/**
 * In-memory audit event store implementation.
 *
 * ⚠️ NON-PRODUCTION: This implementation stores events in memory and is
 * intended for testing and development only. Production deployments must
 * use a durable persistence layer (e.g., append-only database).
 *
 * @see Requirement 21.4 - Retention enforcement (≥365 days minimum)
 */

import type { AuditEvent } from '@may/types';
import type { IAuditEventStore, AuditQuery, AuditQueryResponse } from './interfaces/index.js';

/**
 * In-memory implementation of the audit event store.
 * Events are stored per-tenant in insertion order.
 *
 * ⚠️ NOT FOR PRODUCTION USE — data is lost on process restart.
 */
export class InMemoryAuditEventStore implements IAuditEventStore {
  /** Per-tenant event chains, keyed by tenant_id */
  private readonly chains: Map<string, AuditEvent[]> = new Map();

  /**
   * Appends an event to the tenant's chain.
   *
   * @param event - The complete audit event to persist
   */
  async append(event: AuditEvent): Promise<void> {
    const chain = this.chains.get(event.tenant_id);
    if (chain) {
      chain.push(event);
    } else {
      this.chains.set(event.tenant_id, [event]);
    }
  }

  /**
   * Retrieves the last event in a tenant's chain.
   *
   * @param tenantId - The tenant identifier
   * @returns The last event or null if no events exist
   */
  async getLastEvent(tenantId: string): Promise<AuditEvent | null> {
    const chain = this.chains.get(tenantId);
    if (!chain || chain.length === 0) {
      return null;
    }
    return chain[chain.length - 1]!;
  }

  /**
   * Queries events for a tenant with optional filters.
   *
   * @param query - Query parameters
   * @returns Matching events and total count
   */
  async query(query: AuditQuery): Promise<AuditQueryResponse> {
    const chain = this.chains.get(query.tenant_id) ?? [];
    let filtered = chain.filter((event) => this.matchesFilters(event, query));

    const total_count = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;

    filtered = filtered.slice(offset, offset + limit);

    return {
      events: filtered,
      total_count,
    };
  }

  /**
   * Retrieves events in a sequence range for chain verification.
   *
   * @param tenantId - The tenant identifier
   * @param fromSequence - Start sequence number (inclusive)
   * @param toSequence - End sequence number (inclusive)
   * @returns Events in the specified range, ordered by sequence_number
   */
  async getRange(
    tenantId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<readonly AuditEvent[]> {
    const chain = this.chains.get(tenantId) ?? [];
    return chain.filter(
      (event) =>
        event.sequence_number >= fromSequence &&
        event.sequence_number <= toSequence,
    );
  }

  /**
   * Deletes events older than the specified cutoff timestamp for a tenant.
   *
   * @param tenantId - The tenant identifier
   * @param cutoffTimestamp - ISO 8601 timestamp; events with timestamp < cutoff are deleted
   * @returns Number of events deleted
   */
  async deleteOlderThan(tenantId: string, cutoffTimestamp: string): Promise<number> {
    const chain = this.chains.get(tenantId);
    if (!chain || chain.length === 0) {
      return 0;
    }

    const originalLength = chain.length;
    const remaining = chain.filter((event) => event.timestamp >= cutoffTimestamp);
    this.chains.set(tenantId, remaining);

    return originalLength - remaining.length;
  }

  /**
   * Returns all tenant IDs that have stored events.
   */
  async getTenantIds(): Promise<readonly string[]> {
    return Array.from(this.chains.keys());
  }

  /**
   * Checks if an event matches the query filters.
   */
  private matchesFilters(event: AuditEvent, query: AuditQuery): boolean {
    if (query.from_timestamp && event.timestamp < query.from_timestamp) {
      return false;
    }
    if (query.to_timestamp && event.timestamp > query.to_timestamp) {
      return false;
    }
    if (query.source_service && event.source_service !== query.source_service) {
      return false;
    }
    if (query.event_category && event.event_category !== query.event_category) {
      return false;
    }
    if (query.severity && event.severity !== query.severity) {
      return false;
    }
    if (query.correlation_id && event.correlation_id !== query.correlation_id) {
      return false;
    }
    return true;
  }
}
