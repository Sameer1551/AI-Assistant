/**
 * Audit event emitter for action execution lifecycle.
 *
 * Emits audit events for every action execution phase:
 * - action.started: When execution begins
 * - action.completed: When execution succeeds
 * - action.failed: When execution fails
 * - action.timeout: When execution exceeds timeout
 * - action.cancelled: When execution is cancelled
 * - action.denied: When execution is denied
 * - action.idempotent_hit: When a cached result is returned
 *
 * All events must be emitted within 1 second of the triggering event.
 *
 * @see Requirement 2.6 - Emit audit event within 1s of completion
 */

import type { ActionOutcome, ActionRequest, AuditSeverity } from '@may/types';
import type {
  ActionAuditCategory,
  AuditEmitResult,
  IIntegratedAuditEmitter,
} from './interfaces/index.js';

/**
 * Interface for the audit service client used by the emitter.
 * This is a simplified interface matching what the control service needs
 * from the audit service.
 */
export interface IAuditServiceClient {
  /**
   * Ingests an audit event.
   *
   * @returns The assigned event_id
   */
  ingest(event: {
    timestamp: string;
    tenant_id: string;
    principal_id: string;
    source_service: string;
    event_category: string;
    severity: AuditSeverity;
    correlation_id: string;
    outcome: string;
    payload?: Record<string, unknown>;
  }): Promise<{ event_id: string }>;
}

/**
 * Maps action outcomes to audit severity levels.
 */
function getSeverityForOutcome(outcome: ActionOutcome): AuditSeverity {
  switch (outcome) {
    case 'SUCCESS':
      return 'INFO';
    case 'FAILURE':
      return 'MEDIUM';
    case 'TIMEOUT':
      return 'MEDIUM';
    case 'CANCELLED':
      return 'LOW';
    case 'DENIED':
      return 'HIGH';
  }
}

/**
 * Maps audit categories to severity levels for started events.
 */
function getSeverityForCategory(category: ActionAuditCategory): AuditSeverity {
  switch (category) {
    case 'action.started':
      return 'INFO';
    case 'action.completed':
      return 'INFO';
    case 'action.failed':
      return 'MEDIUM';
    case 'action.timeout':
      return 'MEDIUM';
    case 'action.cancelled':
      return 'LOW';
    case 'action.denied':
      return 'HIGH';
    case 'action.idempotent_hit':
      return 'INFO';
  }
}

/**
 * Emits audit events for action execution lifecycle.
 *
 * Uses the audit service client to emit events. If the audit service
 * is unavailable, the emitter logs the failure but does not block
 * the action execution.
 */
export class ActionAuditEmitter implements IIntegratedAuditEmitter {
  private static readonly SOURCE_SERVICE = 'Control_Service';

  constructor(
    private readonly auditClient: IAuditServiceClient,
    private readonly getNow: () => number = () => Date.now(),
  ) {}

  async emit(
    request: ActionRequest,
    category: ActionAuditCategory,
    outcome: ActionOutcome,
    durationMs: number,
    details?: Record<string, unknown>,
  ): Promise<AuditEmitResult> {
    const emitStart = this.getNow();

    const severity = category === 'action.started'
      ? getSeverityForCategory(category)
      : getSeverityForOutcome(outcome);

    const payload: Record<string, unknown> = {
      action_id: request.action_id,
      action_type: request.action_type,
      risk_level: request.risk_level,
      idempotency_key: request.idempotency_key,
      outcome,
      duration_ms: durationMs,
    };

    if (details) {
      payload['details'] = details;
    }

    try {
      const result = await this.auditClient.ingest({
        timestamp: new Date(this.getNow()).toISOString(),
        tenant_id: request.context.tenant_id as string,
        principal_id: request.context.principal_id as string,
        source_service: ActionAuditEmitter.SOURCE_SERVICE,
        event_category: category,
        severity,
        correlation_id: request.context.correlation_id as string,
        outcome,
        payload,
      });

      const emitDuration = this.getNow() - emitStart;

      return {
        event_id: result.event_id,
        success: true,
        emit_duration_ms: emitDuration,
      };
    } catch {
      const emitDuration = this.getNow() - emitStart;

      return {
        event_id: '',
        success: false,
        emit_duration_ms: emitDuration,
      };
    }
  }
}
