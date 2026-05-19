/**
 * Memory service interfaces — contracts for all injectable dependencies.
 */

import type { MemoryRecord, MemoryLayer, Provenance } from '@may/types';
import type { DataClassification } from '@may/types';

// ─── Request / Response Types ─────────────────────────────────────────────────

export interface WriteMemoryRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly embedding?: readonly number[];
  readonly embedding_model_version?: string;
  readonly classification?: DataClassification;
  readonly metadata?: Record<string, string>;
  readonly expires_at?: string;
}

export interface WriteMemoryResponse {
  readonly record_id: string;
  readonly layer: MemoryLayer;
  readonly classification: DataClassification;
  readonly created_at: string;
}

export interface QueryMemoryRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly layer?: MemoryLayer;
  readonly query_embedding?: readonly number[];
  readonly query_text?: string;
  readonly max_results?: number;
  readonly intent_node_labels?: readonly string[];
}

export interface QueryMemoryResponse {
  readonly records: readonly ScoredMemoryRecord[];
  readonly total_searched: number;
}

export interface ScoredMemoryRecord {
  readonly record: MemoryRecord;
  readonly relevance_score: number;
  readonly temporal_score: number;
  readonly composite_score: number;
}

export interface DeleteMemoryRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly record_id: string;
}

export interface ApplyRetentionRequest {
  readonly tenant_id: string;
}

export interface ApplyRetentionResponse {
  readonly expired_count: number;
  readonly deleted_record_ids: readonly string[];
}

// ─── Memory Weighting Config ──────────────────────────────────────────────────

export interface MemoryWeightingConfig {
  readonly frequency_boost_max: number;     // default 1.3
  readonly priority_boost_factor: number;   // default 1.4 for unresolved/active
  readonly intent_resonance_boost: number;  // default 1.5 for matching intent labels
  /** Half-life in days per layer */
  readonly half_life_days: Readonly<Record<MemoryLayer, number>>;
}

export const DEFAULT_WEIGHTING_CONFIG: MemoryWeightingConfig = {
  frequency_boost_max: 1.3,
  priority_boost_factor: 1.4,
  intent_resonance_boost: 1.5,
  half_life_days: {
    Working_Memory: 1,
    Episodic_Memory: 30,
    Semantic_Memory: 90,
    Procedural_Memory: 180,
    Knowledge_Graph_Memory: 180,
  },
};

// ─── Dependency Interfaces ────────────────────────────────────────────────────

export interface IMemoryStore {
  save(record: MemoryRecord): Promise<void>;
  findById(recordId: string, tenantId: string): Promise<MemoryRecord | null>;
  findByTenantAndPrincipal(
    tenantId: string,
    principalId: string,
    layer?: MemoryLayer,
  ): Promise<readonly MemoryRecord[]>;
  delete(recordId: string, tenantId: string): Promise<boolean>;
  findExpired(tenantId: string, now: Date): Promise<readonly MemoryRecord[]>;
  incrementAccessCount(recordId: string): Promise<void>;
  getAccessCount(recordId: string): Promise<number>;
}

export interface IGovernanceRedactor {
  redact(content: string, tenantId: string): Promise<{
    redacted_content: string;
    classification: DataClassification;
  }>;
}

export interface IEmbeddingService {
  embed(text: string): Promise<{ vector: readonly number[]; model_version: string }>;
  similarity(a: readonly number[], b: readonly number[]): number;
}

export interface IMemoryIdGenerator {
  uuid(): string;
}

export interface IMemoryClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditEmitter {
  emit(event: {
    event_type: string;
    tenant_id: string;
    principal_id: string;
    record_id?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

export interface IMemoryService {
  write(request: WriteMemoryRequest, provenance: Provenance): Promise<WriteMemoryResponse>;
  query(request: QueryMemoryRequest): Promise<QueryMemoryResponse>;
  delete(request: DeleteMemoryRequest): Promise<void>;
  applyRetention(request: ApplyRetentionRequest): Promise<ApplyRetentionResponse>;
}
