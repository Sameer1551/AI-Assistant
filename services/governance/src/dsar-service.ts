/**
 * DSARService - Data Subject Access Request processing.
 *
 * Implements the IDSARService interface to handle DSAR submissions,
 * acknowledgments, erasure processing, and data exports.
 *
 * @see Requirement 27 - Data Subject Rights
 */

import type { DSARRequest, DSARStatus, RequestContext } from '@may/types';
import type {
  IDSARService,
  IDSARStore,
  IDataOwningService,
  ILegalHoldChecker,
  IDSARClock,
  IDSARIdGenerator,
  SubmitDSARRequest,
  DSARAcknowledgment,
  ErasureResult,
  LegalHoldExclusion,
  DSARExportResult,
} from './interfaces/index.js';

/**
 * Concrete implementation of the DSAR service.
 *
 * Handles the full lifecycle of data subject access requests:
 * - Intake and acknowledgment (within 72h)
 * - Erasure order issuance to all owning services
 * - Legal hold exclusion with documented basis
 * - Machine-readable export generation (within 30 days)
 */
export class DSARService implements IDSARService {
  constructor(
    private readonly store: IDSARStore,
    private readonly dataOwningServices: readonly IDataOwningService[],
    private readonly legalHoldChecker: ILegalHoldChecker,
    private readonly clock: IDSARClock,
    private readonly idGenerator: IDSARIdGenerator,
  ) {}

  async submitRequest(
    request: SubmitDSARRequest,
    ctx: RequestContext,
  ): Promise<DSARAcknowledgment> {
    this.validateSubmitRequest(request);

    const now = this.clock.now();
    const dsarId = this.idGenerator.uuid();
    const dueDate = this.computeDueDate(now);

    const dsarRequest: DSARRequest = {
      dsar_id: dsarId,
      tenant_id: ctx.tenant_id,
      data_subject_id: request.data_subject_id,
      request_type: request.request_type,
      submitted_at: now,
      acknowledged_at: now, // Auto-acknowledge on submission
      due_date: dueDate,
      status: 'acknowledged',
      service_completion: {},
    };

    await this.store.save(dsarRequest);

    return {
      dsar_id: dsarId,
      acknowledged_at: now,
      due_date: dueDate,
      status: 'acknowledged',
    };
  }

  async acknowledge(dsarId: string, ctx: RequestContext): Promise<DSARAcknowledgment> {
    const dsar = await this.store.findById(dsarId, ctx.tenant_id);
    if (!dsar) {
      throw this.createError('NOT_FOUND', `DSAR ${dsarId} not found`);
    }

    if (dsar.status !== 'received') {
      // Already acknowledged or further along
      return {
        dsar_id: dsar.dsar_id,
        acknowledged_at: dsar.acknowledged_at ?? this.clock.now(),
        due_date: dsar.due_date,
        status: dsar.status,
      };
    }

    const now = this.clock.now();
    const submittedAt = new Date(dsar.submitted_at).getTime();
    const acknowledgedAt = new Date(now).getTime();
    const seventyTwoHoursMs = 72 * 60 * 60 * 1000;

    if (acknowledgedAt - submittedAt > seventyTwoHoursMs) {
      throw this.createError(
        'DEADLINE_EXCEEDED',
        `DSAR ${dsarId} acknowledgment deadline exceeded (72h from submission)`,
      );
    }

    const updated: DSARRequest = {
      ...dsar,
      acknowledged_at: now,
      status: 'acknowledged',
    };

    await this.store.update(updated);

    return {
      dsar_id: updated.dsar_id,
      acknowledged_at: now,
      due_date: updated.due_date,
      status: 'acknowledged',
    };
  }

  async processErasure(dsarId: string, ctx: RequestContext): Promise<ErasureResult> {
    const dsar = await this.store.findById(dsarId, ctx.tenant_id);
    if (!dsar) {
      throw this.createError('NOT_FOUND', `DSAR ${dsarId} not found`);
    }

    if (dsar.request_type !== 'erasure') {
      throw this.createError(
        'INVALID_REQUEST',
        `DSAR ${dsarId} is not an erasure request (type: ${dsar.request_type})`,
      );
    }

    const serviceCompletion: Record<string, boolean> = {};
    const legalHoldExclusions: LegalHoldExclusion[] = [];

    // Issue erasure orders to all owning services
    for (const service of this.dataOwningServices) {
      // Check legal hold first
      const holdExclusion = await this.legalHoldChecker.checkHold(
        service.serviceName,
        dsar.data_subject_id,
        ctx.tenant_id,
      );

      if (holdExclusion) {
        // Exclude from erasure, document the basis
        legalHoldExclusions.push(holdExclusion);
        serviceCompletion[service.serviceName] = false;
      } else {
        // Execute erasure order
        const completed = await service.executeErasure(
          dsar.data_subject_id,
          ctx.tenant_id,
        );
        serviceCompletion[service.serviceName] = completed;
      }
    }

    // Determine overall completion status
    const allNonHeldCompleted = Object.entries(serviceCompletion)
      .filter(([name]) => !legalHoldExclusions.some((e) => e.service_name === name))
      .every(([, completed]) => completed);

    const newStatus: DSARStatus = allNonHeldCompleted
      ? legalHoldExclusions.length > 0
        ? 'partially_completed'
        : 'completed'
      : 'in_progress';

    // Update the DSAR record
    const updated: DSARRequest = {
      ...dsar,
      status: newStatus,
      service_completion: serviceCompletion,
    };

    await this.store.update(updated);

    return {
      dsar_id: dsarId,
      service_completion: serviceCompletion,
      legal_hold_exclusions: legalHoldExclusions,
      fully_completed: allNonHeldCompleted && legalHoldExclusions.length === 0,
    };
  }

  async generateExport(dsarId: string, ctx: RequestContext): Promise<DSARExportResult> {
    const dsar = await this.store.findById(dsarId, ctx.tenant_id);
    if (!dsar) {
      throw this.createError('NOT_FOUND', `DSAR ${dsarId} not found`);
    }

    if (dsar.request_type !== 'export' && dsar.request_type !== 'access') {
      throw this.createError(
        'INVALID_REQUEST',
        `DSAR ${dsarId} is not an export or access request (type: ${dsar.request_type})`,
      );
    }

    // Check due date compliance
    const now = new Date(this.clock.now()).getTime();
    const dueDate = new Date(dsar.due_date).getTime();
    if (now > dueDate) {
      // Log warning but still produce the export
    }

    // Collect data from all owning services
    const exportData: Record<string, unknown> = {};
    const contributingServices: string[] = [];

    for (const service of this.dataOwningServices) {
      const serviceData = await service.exportData(
        dsar.data_subject_id,
        ctx.tenant_id,
      );

      if (Object.keys(serviceData).length > 0) {
        exportData[service.serviceName] = serviceData;
        contributingServices.push(service.serviceName);
      }
    }

    const generatedAt = this.clock.now();

    // Update DSAR status to completed
    const updated: DSARRequest = {
      ...dsar,
      status: 'completed',
      service_completion: Object.fromEntries(
        contributingServices.map((s) => [s, true]),
      ),
    };

    await this.store.update(updated);

    return {
      dsar_id: dsarId,
      format: 'application/json',
      data: exportData,
      generated_at: generatedAt,
      contributing_services: contributingServices,
    };
  }

  async getRequest(dsarId: string, ctx: RequestContext): Promise<DSARRequest | null> {
    return this.store.findById(dsarId, ctx.tenant_id);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private validateSubmitRequest(request: SubmitDSARRequest): void {
    if (!request.data_subject_id || request.data_subject_id.trim() === '') {
      throw this.createError('VALIDATION', 'data_subject_id is required');
    }

    const validTypes: readonly string[] = ['access', 'rectification', 'export', 'erasure'];
    if (!validTypes.includes(request.request_type)) {
      throw this.createError(
        'VALIDATION',
        `Invalid request_type: ${request.request_type}. Must be one of: ${validTypes.join(', ')}`,
      );
    }
  }

  /**
   * Computes the due date as 30 calendar days from submission.
   */
  private computeDueDate(submittedAt: string): string {
    const date = new Date(submittedAt);
    date.setDate(date.getDate() + 30);
    return date.toISOString();
  }

  private createError(code: string, message: string): Error {
    const error = new Error(message) as Error & { code: string; category: string };
    error.code = code;
    error.category = code;
    return error;
  }
}
