/**
 * @module memory
 * Memory layer data models for the Memory_Service.
 *
 * The Memory_Service provides five named memory layers with tenant/principal
 * isolation and governance integration. All memory writes pass through the
 * Governance_Service redaction pipeline before persistence.
 *
 * @see Requirement 5.1 - Five named memory layers
 */

/**
 * The five named memory layers supported by the Memory_Service.
 *
 * - Working_Memory: Short-term, session-scoped context
 * - Episodic_Memory: Event-based autobiographical records
 * - Semantic_Memory: Factual knowledge and concepts
 * - Procedural_Memory: Learned procedures and workflows
 * - Knowledge_Graph_Memory: Structured relationships and entities
 */
export type MemoryLayer =
  | 'Working_Memory'
  | 'Episodic_Memory'
  | 'Semantic_Memory'
  | 'Procedural_Memory'
  | 'Knowledge_Graph_Memory';

/**
 * Provenance metadata attached to each memory record, tracking
 * the origin and context of the data.
 */
export interface Provenance {
  /** The service that produced this record */
  readonly source_service: string;

  /** The action or operation that generated this record */
  readonly source_action: string;

  /** Correlation identifier linking to the originating request */
  readonly correlation_id: string;

  /** ISO 8601 timestamp of when the record was created */
  readonly timestamp: string;
}

/**
 * A single memory record stored in one of the five memory layers.
 *
 * Records are isolated by tenant_id and principal_id. Content is
 * serialized as JSON only (no pickle or code-executing formats).
 * All records include provenance metadata and an embedding vector
 * with its model version for backfill support.
 */
export interface MemoryRecord {
  /** Unique identifier for this record (UUID) */
  readonly record_id: string;

  /** Tenant boundary identifier */
  readonly tenant_id: string;

  /** Principal (user or service) that owns this record */
  readonly principal_id: string;

  /** Which memory layer this record belongs to */
  readonly layer: MemoryLayer;

  /** Serialized content (JSON only, no pickle/code-executing formats) */
  readonly content: string;

  /** Vector embedding for similarity search */
  readonly embedding: readonly number[];

  /** Version of the embedding model used, for backfill on model upgrade */
  readonly embedding_model_version: string;

  /** Data classification assigned by the Governance_Service */
  readonly classification: import('./governance.js').DataClassification;

  /** Provenance metadata tracking the origin of this record */
  readonly provenance: Provenance;

  /** ISO 8601 timestamp of record creation */
  readonly created_at: string;

  /** ISO 8601 timestamp when this record expires (retention-driven) */
  readonly expires_at?: string;

  /** Arbitrary key-value metadata */
  readonly metadata: Readonly<Record<string, string>>;
}
