/**
 * Property-based tests for dry-run preview, rollback tracking, and self-healing selectors.
 *
 * **Validates: Requirements 2.12, 2.14, 2.15**
 *
 * Property 101: Dry-Run Preview — For any action request, the dry-run preview
 *   service must return a valid DryRunResult containing predicted effects,
 *   risk assessment, reversibility classification, and affected resources
 *   without actually executing the action.
 *
 * Property 102: Rollback Tracking — For any MEDIUM+ risk action that completes
 *   with SUCCESS outcome, the rollback tracker must record a rollback descriptor
 *   with valid steps. For SAFE/LOW risk actions or non-SUCCESS outcomes, no
 *   rollback descriptor should be recorded.
 *
 * Property 103: Self-Healing Selectors — For any broken selector where at least
 *   one healing strategy can find a matching element with confidence >= 0.7,
 *   the self-healing selector must return a healed result with the new selector
 *   and the strategy used.
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@may/testing';
import { DryRunPreviewService } from '../src/dry-run-preview-service.js';
import { RollbackTracker, DEFAULT_ROLLBACK_RETENTION_HOURS } from '../src/rollback-tracker.js';
import { InMemoryRollbackStore } from '../src/in-memory-rollback-store.js';
import { SelfHealingSelector, MIN_HEAL_CONFIDENCE } from '../src/self-healing-selector.js';
import type { ActionRequest, ActionResponse, RiskLevel, ActionOutcome } from '@may/types';
import type { Reversibility } from '@may/types';
import type {
  IClock,
  IIdGenerator,
  ElementSelector,
  HealingContext,
  ISelectorAuditEmitter,
  SelectorMigrationLog,
} from '../src/interfaces/index.js';
import type {
  ActionId,
  IdempotencyKey,
  TenantId,
  PrincipalId,
  CorrelationId,
  SessionId,
} from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  nowISO(): string {
    return '2024-01-15T10:00:00.000Z';
  }
}

class MockIdGenerator implements IIdGenerator {
  private counter = 0;
  uuid(): string {
    this.counter++;
    return `uuid-${this.counter}`;
  }
}

class MockAuditEmitter implements ISelectorAuditEmitter {
  readonly migrations: SelectorMigrationLog[] = [];
  async emitMigration(log: SelectorMigrationLog): Promise<void> {
    this.migrations.push(log);
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const riskLevelArb = fc.constantFrom<RiskLevel>('SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
const mediumPlusRiskArb = fc.constantFrom<RiskLevel>('MEDIUM', 'HIGH', 'CRITICAL');
const safeLowRiskArb = fc.constantFrom<RiskLevel>('SAFE', 'LOW');
const outcomeArb = fc.constantFrom<ActionOutcome>('SUCCESS', 'FAILURE', 'TIMEOUT', 'CANCELLED', 'DENIED');
const nonSuccessOutcomeArb = fc.constantFrom<ActionOutcome>('FAILURE', 'TIMEOUT', 'CANCELLED', 'DENIED');

const actionTypeArb = fc.constantFrom(
  'file.delete', 'file.create', 'file.move',
  'browser.navigate', 'browser.click', 'browser.type',
  'app.focus', 'app.launch', 'system.command',
);

const identifierArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 4, maxLength: 12 },
);

const parametersArb = fc.oneof(
  fc.record({ path: fc.constant('/tmp/test.txt') }),
  fc.record({ url: fc.constant('https://example.com') }),
  fc.record({ target: fc.constant('vscode') }),
  fc.constant({ key: 'value' }),
);

/** Generates a valid ActionRequest with the given risk level. */
function makeRequest(riskLevel: RiskLevel, actionType: string, params: Record<string, unknown>): ActionRequest {
  return {
    action_id: `action-${Math.random().toString(36).slice(2, 10)}` as unknown as ActionId,
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 10)}` as unknown as IdempotencyKey,
    risk_level: riskLevel,
    action_type: actionType,
    parameters: params,
    timeout_seconds: 60,
    context: {
      tenant_id: 'tenant-001' as unknown as TenantId,
      principal_id: 'user-001' as unknown as PrincipalId,
      correlation_id: 'corr-001' as unknown as CorrelationId,
      trace_context: { traceparent: '00-trace-001-span-001-01' },
      session_id: 'session-001' as unknown as SessionId,
      roles: ['End_User'],
      attributes: {},
      residency_region: 'us-east-1',
    },
  };
}

function makeResponse(request: ActionRequest, outcome: ActionOutcome): ActionResponse {
  return {
    action_id: request.action_id,
    idempotency_key: request.idempotency_key,
    outcome,
    duration_ms: 150,
    audit_event_id: 'audit-001',
    correlation_id: request.context.correlation_id,
  };
}

/** Label arbitrary for self-healing tests. */
const labelArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')),
  { minLength: 3, maxLength: 15 },
).map((s) => s.trim()).filter((s) => s.length >= 3);

// ─── Property 101: Dry-Run Preview ──────────────────────────────────────────

describe('Property 101: Dry-Run Preview', () => {
  /**
   * **Validates: Requirements 2.14**
   *
   * For any action request, the dry-run preview service must return a valid
   * DryRunResult containing predicted effects, risk assessment, reversibility
   * classification, and affected resources without actually executing the action.
   */
  it('returns a valid DryRunResult for any action request', async () => {
    await fc.assert(
      fc.asyncProperty(
        riskLevelArb,
        actionTypeArb,
        parametersArb,
        async (riskLevel, actionType, params) => {
          const clock = new MockClock();
          const service = new DryRunPreviewService({ clock });
          const request = makeRequest(riskLevel, actionType, params);

          const result = await service.generatePreview(request);

          // Must contain the correct action_id
          expect(result.action_id).toBe(request.action_id);

          // Must have predicted_effects as a non-empty array
          expect(Array.isArray(result.predicted_effects)).toBe(true);
          expect(result.predicted_effects.length).toBeGreaterThan(0);

          // Each predicted effect must have required fields
          for (const effect of result.predicted_effects) {
            expect(typeof effect.description).toBe('string');
            expect(effect.description.length).toBeGreaterThan(0);
            expect(typeof effect.resource).toBe('string');
            expect(effect.resource.length).toBeGreaterThan(0);
            expect(['create', 'modify', 'delete', 'move']).toContain(effect.change_type);
            expect(effect.confidence).toBeGreaterThanOrEqual(0);
            expect(effect.confidence).toBeLessThanOrEqual(1);
          }

          // Must have a non-empty risk assessment string
          expect(typeof result.risk_assessment).toBe('string');
          expect(result.risk_assessment.length).toBeGreaterThan(0);

          // Must have a valid reversibility classification
          const validReversibilities: Reversibility[] = [
            'fully_reversible', 'partially_reversible', 'irreversible',
          ];
          expect(validReversibilities).toContain(result.reversibility);

          // Must have affected_resources as a non-empty array
          expect(Array.isArray(result.affected_resources)).toBe(true);
          expect(result.affected_resources.length).toBeGreaterThan(0);

          // Must have a valid ISO timestamp
          expect(typeof result.timestamp).toBe('string');
          expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('does not mutate the original action request (no side effects)', async () => {
    await fc.assert(
      fc.asyncProperty(
        riskLevelArb,
        actionTypeArb,
        parametersArb,
        async (riskLevel, actionType, params) => {
          const clock = new MockClock();
          const service = new DryRunPreviewService({ clock });
          const request = makeRequest(riskLevel, actionType, params);
          const originalJson = JSON.stringify(request);

          await service.generatePreview(request);

          expect(JSON.stringify(request)).toBe(originalJson);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 102: Rollback Tracking ─────────────────────────────────────────

describe('Property 102: Rollback Tracking', () => {
  /**
   * **Validates: Requirements 2.15**
   *
   * For any MEDIUM+ risk action that completes with SUCCESS outcome,
   * the rollback tracker must record a rollback descriptor with valid steps.
   */
  it('records a valid rollback descriptor for MEDIUM+ SUCCESS actions', async () => {
    await fc.assert(
      fc.asyncProperty(
        mediumPlusRiskArb,
        actionTypeArb,
        parametersArb,
        async (riskLevel, actionType, params) => {
          const clock = new MockClock();
          const idGenerator = new MockIdGenerator();
          const store = new InMemoryRollbackStore();
          const tracker = new RollbackTracker({
            clock, idGenerator, store,
            config: { retention_hours: DEFAULT_ROLLBACK_RETENTION_HOURS },
          });

          const request = makeRequest(riskLevel, actionType, params);
          const response = makeResponse(request, 'SUCCESS');

          const descriptor = await tracker.recordRollback(request, response);

          // Must record a descriptor
          expect(descriptor).toBeDefined();
          expect(descriptor!.action_id).toBe(request.action_id);
          expect(descriptor!.tenant_id).toBe(request.context.tenant_id);
          expect(descriptor!.principal_id).toBe(request.context.principal_id);
          expect(descriptor!.action_type).toBe(request.action_type);
          expect(descriptor!.executed).toBe(false);

          // Must have at least one rollback step with valid fields
          expect(descriptor!.rollback_steps.length).toBeGreaterThan(0);
          for (const step of descriptor!.rollback_steps) {
            expect(typeof step.step_id).toBe('string');
            expect(step.step_id.length).toBeGreaterThan(0);
            expect(typeof step.description).toBe('string');
            expect(step.description.length).toBeGreaterThan(0);
            expect(typeof step.reverse_action.action_type).toBe('string');
            expect(step.reverse_action.action_type.length).toBeGreaterThan(0);
            expect(typeof step.reverse_action.timeout_seconds).toBe('number');
            expect(step.order).toBeGreaterThanOrEqual(1);
          }

          // Must have valid timestamps with expiry after creation
          expect(new Date(descriptor!.created_at).toISOString()).toBe(descriptor!.created_at);
          expect(new Date(descriptor!.expires_at).toISOString()).toBe(descriptor!.expires_at);
          expect(new Date(descriptor!.expires_at).getTime())
            .toBeGreaterThan(new Date(descriptor!.created_at).getTime());
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 2.15**
   *
   * For SAFE/LOW risk actions, no rollback descriptor should be recorded.
   */
  it('does NOT record a rollback descriptor for SAFE/LOW risk actions', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeLowRiskArb,
        actionTypeArb,
        parametersArb,
        outcomeArb,
        async (riskLevel, actionType, params, outcome) => {
          const clock = new MockClock();
          const idGenerator = new MockIdGenerator();
          const store = new InMemoryRollbackStore();
          const tracker = new RollbackTracker({
            clock, idGenerator, store,
            config: { retention_hours: DEFAULT_ROLLBACK_RETENTION_HOURS },
          });

          const request = makeRequest(riskLevel, actionType, params);
          const response = makeResponse(request, outcome);

          const descriptor = await tracker.recordRollback(request, response);
          expect(descriptor).toBeUndefined();
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 2.15**
   *
   * For MEDIUM+ risk actions with non-SUCCESS outcomes, no rollback
   * descriptor should be recorded.
   */
  it('does NOT record a rollback descriptor for non-SUCCESS outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(
        mediumPlusRiskArb,
        actionTypeArb,
        parametersArb,
        nonSuccessOutcomeArb,
        async (riskLevel, actionType, params, outcome) => {
          const clock = new MockClock();
          const idGenerator = new MockIdGenerator();
          const store = new InMemoryRollbackStore();
          const tracker = new RollbackTracker({
            clock, idGenerator, store,
            config: { retention_hours: DEFAULT_ROLLBACK_RETENTION_HOURS },
          });

          const request = makeRequest(riskLevel, actionType, params);
          const response = makeResponse(request, outcome);

          const descriptor = await tracker.recordRollback(request, response);
          expect(descriptor).toBeUndefined();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 103: Self-Healing Selectors ────────────────────────────────────

describe('Property 103: Self-Healing Selectors', () => {
  /**
   * **Validates: Requirements 2.12**
   *
   * For any broken selector where at least one healing strategy can find
   * a matching element with confidence >= 0.7, the self-healing selector
   * must return a healed result with the new selector and the strategy used.
   */
  it('heals via accessibility label when a matching element exists', async () => {
    await fc.assert(
      fc.asyncProperty(
        labelArb,
        identifierArb,
        identifierArb,
        async (label, origId, newId) => {
          const auditEmitter = new MockAuditEmitter();
          const clock = new MockClock();
          const service = new SelfHealingSelector({ auditEmitter, clock });

          const originalSelector = `#orig-${origId}`;
          const newSelector = `#new-${newId}`;

          const selector: ElementSelector = {
            primary: originalSelector,
            accessibility_label: label,
          };

          const context: HealingContext = {
            page_url: 'https://example.com',
            available_elements: [
              {
                selector: newSelector,
                tag_name: 'button',
                accessibility_label: label,
                attributes: {},
              },
            ],
          };

          const result = await service.heal(selector, context, 'action-001', 'tenant-001');

          // Must heal successfully
          expect(result.healed).toBe(true);
          expect(result.new_selector).toBe(newSelector);
          expect(result.strategy_used).toBe('accessibility_label');
          expect(result.confidence).toBeGreaterThanOrEqual(MIN_HEAL_CONFIDENCE);

          // Must log the migration
          expect(auditEmitter.migrations).toHaveLength(1);
          expect(auditEmitter.migrations[0].original_selector).toBe(originalSelector);
          expect(auditEmitter.migrations[0].new_selector).toBe(newSelector);
          expect(auditEmitter.migrations[0].strategy_used).toBe('accessibility_label');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('heals via text content when a matching element exists', async () => {
    await fc.assert(
      fc.asyncProperty(
        labelArb,
        identifierArb,
        identifierArb,
        async (text, origId, newId) => {
          const auditEmitter = new MockAuditEmitter();
          const clock = new MockClock();
          const service = new SelfHealingSelector({ auditEmitter, clock });

          const originalSelector = `#orig-${origId}`;
          const newSelector = `#new-${newId}`;

          const selector: ElementSelector = {
            primary: originalSelector,
            text_content: text,
          };

          const context: HealingContext = {
            page_url: 'https://example.com',
            available_elements: [
              {
                selector: newSelector,
                tag_name: 'span',
                text_content: text,
                attributes: {},
              },
            ],
          };

          const result = await service.heal(selector, context, 'action-002', 'tenant-001');

          expect(result.healed).toBe(true);
          expect(result.new_selector).toBe(newSelector);
          expect(result.strategy_used).toBe('text_content');
          expect(result.confidence).toBeGreaterThanOrEqual(MIN_HEAL_CONFIDENCE);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('returns healed=false when no strategy can find a match with sufficient confidence', async () => {
    await fc.assert(
      fc.asyncProperty(
        identifierArb,
        async (origId) => {
          const auditEmitter = new MockAuditEmitter();
          const clock = new MockClock();
          const service = new SelfHealingSelector({ auditEmitter, clock });

          // Selector with no fallback hints that could match
          const selector: ElementSelector = {
            primary: `#broken-${origId}`,
          };

          // Context with elements that have no matching attributes
          const context: HealingContext = {
            page_url: 'https://example.com',
            available_elements: [
              {
                selector: '#unrelated-element',
                tag_name: 'div',
                attributes: {},
              },
            ],
          };

          const result = await service.heal(selector, context, 'action-003', 'tenant-001');

          expect(result.healed).toBe(false);
          expect(result.confidence).toBe(0);
          // All 4 strategies should have been attempted
          expect(result.attempts.length).toBe(4);
          // No audit migration should be emitted
          expect(auditEmitter.migrations).toHaveLength(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('logs migration audit event with correct fields on successful heal', async () => {
    await fc.assert(
      fc.asyncProperty(
        labelArb,
        identifierArb,
        identifierArb,
        identifierArb,
        async (label, origId, newId, actionSuffix) => {
          const auditEmitter = new MockAuditEmitter();
          const clock = new MockClock();
          const service = new SelfHealingSelector({ auditEmitter, clock });

          const originalSelector = `#orig-${origId}`;
          const newSelector = `#new-${newId}`;
          const actionId = `action-${actionSuffix}`;
          const tenantId = 'tenant-test';

          const selector: ElementSelector = {
            primary: originalSelector,
            accessibility_label: label,
          };

          const context: HealingContext = {
            page_url: 'https://example.com',
            available_elements: [
              {
                selector: newSelector,
                tag_name: 'button',
                accessibility_label: label,
                attributes: {},
              },
            ],
          };

          await service.heal(selector, context, actionId, tenantId);

          // Migration log must contain all required fields
          expect(auditEmitter.migrations).toHaveLength(1);
          const log = auditEmitter.migrations[0];
          expect(log.original_selector).toBe(originalSelector);
          expect(log.new_selector).toBe(newSelector);
          expect(log.strategy_used).toBeDefined();
          expect(log.confidence).toBeGreaterThanOrEqual(MIN_HEAL_CONFIDENCE);
          expect(typeof log.timestamp).toBe('string');
          expect(log.action_id).toBe(actionId);
          expect(log.tenant_id).toBe(tenantId);
        },
      ),
      { numRuns: 50 },
    );
  });
});
