/**
 * @module memory-service
 * Core Memory_Service implementation.
 *
 * Implements five-layer memory with:
 * - Tenant and principal isolation on all queries
 * - JSON-only serialization (no pickle/code-executing formats)
 * - Governance_Service redaction pipeline on all writes
 * - Results capped at max_results, ordered by composite score, with provenance
 * - Embedding version logged with each persisted vector
 * - Temporal weighting: decay, frequency boost, priority boost, intent resonance
 *
 * @see Requirements 5.1–5.8, 43.1–43.6
 */

import type { MemoryRecord, Provenance } from '@may/types';
import type {
  IMemoryService,
  IMemoryStore,
  IGovernanceRedactor,
  IEmbeddingService,
  IMemoryIdGenerator,
  IMemoryClock,
  IAuditEmitter,
  MemoryWeightingConfig,
  WriteMemoryRequest,
  WriteMemoryResponse,
  QueryMemoryRequest,
  QueryMemoryResponse,
  ScoredMemoryRecord,
  DeleteMemoryRequest,
  ApplyRetentionRequest,
  ApplyRetentionResponse,
} from './interfaces/index.js';
import { computeTemporalScore } from './temporal-weighting.js';
import { DEFAULT_WEIGHTING_CONFIG } from './interfaces/index.js';

const DEFAULT_MAX_RESULTS = 20;

export interface MemoryServiceDeps {
  readonly store: IMemoryStore;
  readonly redactor: IGovernanceRedactor;
  readonly embedding: IEmbeddingService;
  readonly idGenerator: IMemoryIdGenerator;
  readonly clock: IMemoryClock;
  readonly auditEmitter: IAuditEmitter;
  readonly weightingConfig?: MemoryWeightingConfig;
}

export class MemoryService implements IMemoryService {
  private readonly store: IMemoryStore;
  private readonly redactor: IGovernanceRedactor;
  private readonly embedding: IEmbeddingService;
  private readonly idGenerator: IMemoryIdGenerator;
  private readonly clock: IMemoryClock;
  private readonly auditEmitter: IAuditEmitter;
  private readonly weightingConfig: MemoryWeightingConfig;

  constructor(deps: MemoryServiceDeps) {
    this.store = deps.store;
    this.redactor = deps.redactor;
    this.embedding = deps.embedding;
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditEmitter = deps.auditEmitter;
    this.weightingConfig = deps.weightingConfig ?? DEFAULT_WEIGHTING_CONFIG;
  }

  /**
   * Write a memory record after passing through the governance redaction pipeline.
   *
   * Content is serialized as JSON string only. Embedding is generated and versioned.
   *
   * @see Requirement 5.1 — five named memory layers
   * @see Requirement 5.3 — pass all writes through Governance_Service
   * @see Requirement 5.7 — log embedding version with each persisted vector
   */
  async write(request: WriteMemoryRequest, provenance: Provenance): Promise<WriteMemoryResponse> {
    const {
      tenant_id,
      principal_id,
      layer,
      content,
      metadata = {},
      expires_at,
    } = request;

    // Validate JSON-only serialization — content must be valid JSON or plain string
    let serializedContent: string;
    try {
      // Ensure content can be safely round-tripped as JSON (no code-executing formats)
      serializedContent = JSON.stringify(JSON.parse(content));
    } catch {
      // If content is not JSON, store as a JSON string wrapper
      serializedContent = JSON.stringify({ text: content });
    }

    // Pass through Governance_Service redaction pipeline
    const { redacted_content, classification } = await this.redactor.redact(
      serializedContent,
      tenant_id,
    );

    // Generate embedding for the record
    let embedding: readonly number[];
    let embedding_model_version: string;

    if (request.embedding && request.embedding_model_version) {
      embedding = request.embedding;
      embedding_model_version = request.embedding_model_version;
    } else {
      const result = await this.embedding.embed(redacted_content);
      embedding = result.vector;
      embedding_model_version = result.model_version;
    }

    const record_id = this.idGenerator.uuid();
    const created_at = this.clock.nowISO();

    const record: MemoryRecord = {
      record_id,
      tenant_id,
      principal_id,
      layer,
      content: redacted_content,
      embedding,
      embedding_model_version,
      classification: request.classification ?? classification,
      provenance,
      created_at,
      expires_at,
      metadata,
    };

    await this.store.save(record);

    await this.auditEmitter.emit({
      event_type: 'memory.write',
      tenant_id,
      principal_id,
      record_id,
      details: { layer, classification: record.classification },
    });

    return { record_id, layer, classification: record.classification, created_at };
  }

  /**
   * Query memory records with tenant/principal isolation and temporal scoring.
   *
   * Results are capped at max_results, ordered by composite relevance score,
   * and include full provenance metadata.
   *
   * @see Requirement 5.2 — tenant and principal isolation
   * @see Requirement 5.5 — cap results, order by relevance, include provenance
   */
  async query(request: QueryMemoryRequest): Promise<QueryMemoryResponse> {
    const {
      tenant_id,
      principal_id,
      layer,
      query_embedding,
      max_results = DEFAULT_MAX_RESULTS,
      intent_node_labels = [],
    } = request;

    // Fetch all records for tenant/principal — isolation enforced at store level
    const candidates = await this.store.findByTenantAndPrincipal(tenant_id, principal_id, layer);

    const now = new Date(this.clock.nowISO());
    const scored: ScoredMemoryRecord[] = [];

    for (const record of candidates) {
      // Skip expired records
      if (record.expires_at && record.expires_at <= this.clock.nowISO()) continue;

      // Compute relevance from embedding similarity (or use 1.0 if no query embedding)
      let relevance = 1.0;
      if (query_embedding && query_embedding.length > 0 && record.embedding.length > 0) {
        relevance = this.embedding.similarity(query_embedding, record.embedding);
      }

      // Increment access count for retrieval (re: Requirement 43.6)
      await this.store.incrementAccessCount(record.record_id);
      const accessCount = await this.store.getAccessCount(record.record_id);

      const temporalScore = computeTemporalScore(
        record,
        accessCount,
        intent_node_labels,
        this.weightingConfig,
        now,
      );

      scored.push({
        record,
        relevance_score: relevance,
        temporal_score: temporalScore,
        composite_score: relevance * temporalScore,
      });
    }

    // Sort by composite score descending, then cap
    scored.sort((a, b) => b.composite_score - a.composite_score);
    const capped = scored.slice(0, max_results);

    return { records: capped, total_searched: candidates.length };
  }

  /**
   * Delete a memory record for a specific tenant/principal.
   *
   * @see Requirement 5.4 — tenant-isolated deletion
   */
  async delete(request: DeleteMemoryRequest): Promise<void> {
    const { tenant_id, principal_id, record_id } = request;

    const record = await this.store.findById(record_id, tenant_id);
    if (!record) {
      throw new Error(`Memory record not found: ${record_id}`);
    }
    // Enforce principal isolation
    if (record.principal_id !== principal_id) {
      throw new Error(`Access denied: record belongs to different principal`);
    }

    await this.store.delete(record_id, tenant_id);

    await this.auditEmitter.emit({
      event_type: 'memory.delete',
      tenant_id,
      principal_id,
      record_id,
    });
  }

  /**
   * Apply retention policy — find and delete expired records.
   *
   * @see Requirement 5.6 — retention enforcement
   */
  async applyRetention(request: ApplyRetentionRequest): Promise<ApplyRetentionResponse> {
    const { tenant_id } = request;
    const now = new Date(this.clock.nowISO());

    const expired = await this.store.findExpired(tenant_id, now);
    const deletedIds: string[] = [];

    for (const record of expired) {
      const deleted = await this.store.delete(record.record_id, tenant_id);
      if (deleted) {
        deletedIds.push(record.record_id);
        await this.auditEmitter.emit({
          event_type: 'memory.retention_delete',
          tenant_id,
          principal_id: record.principal_id,
          record_id: record.record_id,
          details: { layer: record.layer, expires_at: record.expires_at },
        });
      }
    }

    return { expired_count: deletedIds.length, deleted_record_ids: deletedIds };
  }
}
