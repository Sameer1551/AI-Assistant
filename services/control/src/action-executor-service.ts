/**
 * Action Executor Service — integrates idempotency, timeout, and audit emission.
 *
 * This service wraps action execution with three cross-cutting concerns:
 * 1. Idempotency: Duplicate requests return cached results without re-execution
 * 2. Timeout: Actions exceeding their configured timeout are terminated
 * 3. Audit: Every lifecycle event is emitted to the audit trail
 *
 * @see Requirement 2.6 - Emit audit event within 1s of completion
 * @see Requirement 2.7 - Idempotency keys with 24h deduplication window
 * @see Requirement 2.8 - Per-action timeout (1-600s, default 60s)
 */

import type { ActionRequest, ActionResponse, CorrelationId } from '@may/types';
import type {
  ActionExecutorFn,
  IActionExecutorService,
  IIntegratedAuditEmitter,
  IIdempotencyStore,
  ITimeoutEnforcer,
} from './interfaces/index.js';

/**
 * Action Executor Service implementation.
 *
 * Orchestrates the execution of actions with idempotency deduplication,
 * timeout enforcement, and audit event emission at each lifecycle phase.
 *
 * Execution flow:
 * 1. Check idempotency store → if hit, emit audit and return cached result
 * 2. Emit action.started audit event
 * 3. Execute action with timeout enforcement
 * 4. On success: emit action.completed, cache result
 * 5. On timeout: emit action.timeout, build TIMEOUT response
 * 6. On failure: emit action.failed, build FAILURE response
 */
export class ActionExecutorService implements IActionExecutorService {
  constructor(
    private readonly idempotencyStore: IIdempotencyStore,
    private readonly timeoutEnforcer: ITimeoutEnforcer,
    private readonly auditEmitter: IIntegratedAuditEmitter,
    private readonly getNow: () => number = () => Date.now(),
  ) {}

  async execute(request: ActionRequest, executor: ActionExecutorFn): Promise<ActionResponse> {
    const startTime = this.getNow();

    // Step 1: Check idempotency store for cached result
    const cached = await this.idempotencyStore.get(request.idempotency_key as string);
    if (cached) {
      // Emit idempotent hit audit event
      const elapsed = this.getNow() - startTime;
      await this.auditEmitter.emit(
        request,
        'action.idempotent_hit',
        cached.response.outcome,
        elapsed,
        { cached_action_id: cached.response.action_id },
      );

      return cached.response;
    }

    // Step 2: Emit action.started audit event
    await this.auditEmitter.emit(
      request,
      'action.started',
      'SUCCESS', // Started events use SUCCESS as placeholder outcome
      0,
      { timeout_seconds: request.timeout_seconds },
    );

    // Step 3: Execute with timeout enforcement
    const timeoutResult = await this.timeoutEnforcer.executeWithTimeout(
      (signal: AbortSignal) => executor(request, signal),
      request.timeout_seconds,
    );

    // Step 4: Handle result based on completion status
    if (timeoutResult.completed && timeoutResult.result) {
      const response = timeoutResult.result;

      // Emit appropriate audit event based on outcome
      const category = response.outcome === 'SUCCESS' ? 'action.completed' : 'action.failed';
      await this.auditEmitter.emit(
        request,
        category,
        response.outcome,
        timeoutResult.elapsed_ms,
        response.error ? { error: response.error } : undefined,
      );

      // Cache the result for idempotency
      await this.idempotencyStore.set(request.idempotency_key as string, response);

      return response;
    }

    // Step 5: Handle timeout
    const timeoutResponse: ActionResponse = {
      action_id: request.action_id,
      idempotency_key: request.idempotency_key,
      outcome: 'TIMEOUT',
      error: {
        code: 'ACTION_TIMEOUT',
        message: `Action exceeded timeout of ${request.timeout_seconds} seconds`,
        details: {
          timeout_seconds: request.timeout_seconds,
          elapsed_ms: timeoutResult.elapsed_ms,
        },
      },
      duration_ms: timeoutResult.elapsed_ms,
      audit_event_id: '', // Will be filled after audit emission
      correlation_id: request.context.correlation_id as CorrelationId,
    };

    // Emit timeout audit event
    const auditResult = await this.auditEmitter.emit(
      request,
      'action.timeout',
      'TIMEOUT',
      timeoutResult.elapsed_ms,
      {
        timeout_seconds: request.timeout_seconds,
        elapsed_ms: timeoutResult.elapsed_ms,
      },
    );

    // Update response with audit event ID
    const finalResponse: ActionResponse = {
      ...timeoutResponse,
      audit_event_id: auditResult.event_id,
    };

    // Cache the timeout result for idempotency
    await this.idempotencyStore.set(request.idempotency_key as string, finalResponse);

    return finalResponse;
  }
}
