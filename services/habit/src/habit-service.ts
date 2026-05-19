/**
 * @module habit-service
 * Habit_Service: Pattern learning with privacy controls.
 *
 * - Learn patterns only from same End_User principal's event streams
 * - Provide review surface listing patterns with origin, last-observed, confidence
 * - Delete patterns within 60s on user request with audit event
 * - No cross-user/cross-tenant pattern sharing
 * - Disable predictions when tenant disables personalization
 * - Integrate with POKG_Service for application co-occurrence patterns
 *
 * @see Requirements 9.1–9.7
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HabitPattern {
  readonly pattern_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly pattern_type: string;
  readonly description: string;
  readonly origin: string;           // which event stream originated this pattern
  readonly last_observed: string;    // ISO 8601
  readonly confidence: number;       // [0, 1]
  readonly occurrence_count: number;
  readonly created_at: string;
}

export interface LearnPatternRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly pattern_type: string;
  readonly description: string;
  readonly origin: string;
  readonly timestamp: string;
}

export interface PredictRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly context: string;
  readonly personalization_enabled: boolean;
}

export interface HabitPrediction {
  readonly pattern_id: string;
  readonly description: string;
  readonly confidence: number;
  readonly rationale: string;
}

export interface IHabitPatternStore {
  save(pattern: HabitPattern): Promise<void>;
  findByPrincipal(tenantId: string, principalId: string): Promise<readonly HabitPattern[]>;
  findById(patternId: string): Promise<HabitPattern | null>;
  delete(patternId: string, tenantId: string, principalId: string): Promise<boolean>;
  update(pattern: HabitPattern): Promise<void>;
}

export interface IHabitAuditEmitter {
  emit(event: {
    event_type: string;
    tenant_id: string;
    principal_id: string;
    pattern_id?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

export interface IHabitIdGenerator { uuid(): string; }
export interface IHabitClock { nowISO(): string; }

// ─── Service ──────────────────────────────────────────────────────────────────

export interface HabitServiceDeps {
  readonly store: IHabitPatternStore;
  readonly auditEmitter: IHabitAuditEmitter;
  readonly idGenerator: IHabitIdGenerator;
  readonly clock: IHabitClock;
}

export class HabitService {
  private readonly store: IHabitPatternStore;
  private readonly auditEmitter: IHabitAuditEmitter;
  private readonly idGenerator: IHabitIdGenerator;
  private readonly clock: IHabitClock;

  constructor(deps: HabitServiceDeps) {
    this.store = deps.store;
    this.auditEmitter = deps.auditEmitter;
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
  }

  /**
   * Learn a new pattern from a principal's event stream.
   *
   * Patterns are strictly isolated per tenant and principal.
   * No cross-user or cross-tenant data sharing occurs.
   *
   * @see Requirement 9.1 — learn only from same End_User principal's stream
   * @see Requirement 9.4 — no cross-user/cross-tenant sharing
   */
  async learnPattern(request: LearnPatternRequest): Promise<HabitPattern> {
    const { tenant_id, principal_id, pattern_type, description, origin, timestamp } = request;

    const pattern: HabitPattern = {
      pattern_id: this.idGenerator.uuid(),
      tenant_id,
      principal_id,
      pattern_type,
      description,
      origin,
      last_observed: timestamp,
      confidence: 0.5, // Start with medium confidence; increases with occurrences
      occurrence_count: 1,
      created_at: this.clock.nowISO(),
    };

    await this.store.save(pattern);

    await this.auditEmitter.emit({
      event_type: 'habit.pattern_learned',
      tenant_id,
      principal_id,
      pattern_id: pattern.pattern_id,
      details: { pattern_type, origin },
    });

    return pattern;
  }

  /**
   * List all patterns for a principal (review surface).
   *
   * @see Requirement 9.2 — provide review surface with origin, last-observed, confidence
   */
  async listPatterns(tenantId: string, principalId: string): Promise<readonly HabitPattern[]> {
    return this.store.findByPrincipal(tenantId, principalId);
  }

  /**
   * Delete a pattern within 60s on user request, with audit event.
   *
   * Enforces principal and tenant isolation — cannot delete another user's patterns.
   *
   * @see Requirement 9.3 — delete within 60s on user request with audit event
   */
  async deletePattern(patternId: string, tenantId: string, principalId: string): Promise<void> {
    const deleted = await this.store.delete(patternId, tenantId, principalId);
    if (!deleted) {
      throw new Error(`Pattern not found or access denied: ${patternId}`);
    }

    // Emit audit immediately (target: within 60s — Requirement 9.3)
    await this.auditEmitter.emit({
      event_type: 'habit.pattern_deleted',
      tenant_id: tenantId,
      principal_id: principalId,
      pattern_id: patternId,
      details: { requested_by: principalId },
    });
  }

  /**
   * Predict next action based on learned patterns.
   *
   * Returns empty array when personalization is disabled (Requirement 9.5).
   *
   * @see Requirement 9.5 — disable predictions when tenant disables personalization
   */
  async predict(request: PredictRequest): Promise<readonly HabitPrediction[]> {
    const { tenant_id, principal_id, context, personalization_enabled } = request;

    // Disable predictions when tenant disables personalization (Req 9.5)
    if (!personalization_enabled) {
      return [];
    }

    const patterns = await this.store.findByPrincipal(tenant_id, principal_id);

    // Simple scoring: patterns matching context tokens, scored by confidence
    const contextLower = context.toLowerCase();
    return patterns
      .filter((p) => contextLower.includes(p.pattern_type.toLowerCase()) || p.confidence > 0.7)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map((p) => ({
        pattern_id: p.pattern_id,
        description: p.description,
        confidence: p.confidence,
        rationale: `Based on ${p.occurrence_count} observations from ${p.origin}`,
      }));
  }
}

// ─── In-Memory Store ──────────────────────────────────────────────────────────

export class InMemoryHabitStore implements IHabitPatternStore {
  private readonly patterns = new Map<string, HabitPattern>();

  async save(pattern: HabitPattern): Promise<void> {
    this.patterns.set(pattern.pattern_id, pattern);
  }

  async findByPrincipal(tenantId: string, principalId: string): Promise<readonly HabitPattern[]> {
    return Array.from(this.patterns.values()).filter(
      (p) => p.tenant_id === tenantId && p.principal_id === principalId,
    );
  }

  async findById(patternId: string): Promise<HabitPattern | null> {
    return this.patterns.get(patternId) ?? null;
  }

  async delete(patternId: string, tenantId: string, principalId: string): Promise<boolean> {
    const p = this.patterns.get(patternId);
    if (!p || p.tenant_id !== tenantId || p.principal_id !== principalId) return false;
    this.patterns.delete(patternId);
    return true;
  }

  async update(pattern: HabitPattern): Promise<void> {
    this.patterns.set(pattern.pattern_id, pattern);
  }
}
