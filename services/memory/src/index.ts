/**
 * @may/memory — Memory Service entry point
 */

export { MemoryService } from './memory-service.js';
export { InMemoryMemoryStore } from './in-memory-store.js';
export {
  computeTemporalDecay,
  computeFrequencyBoost,
  computePriorityBoost,
  computeIntentResonanceBoost,
  computeTemporalScore,
} from './temporal-weighting.js';
export type {
  IMemoryService,
  IMemoryStore,
  IGovernanceRedactor,
  IEmbeddingService,
  WriteMemoryRequest,
  WriteMemoryResponse,
  QueryMemoryRequest,
  QueryMemoryResponse,
  ScoredMemoryRecord,
  DeleteMemoryRequest,
  ApplyRetentionRequest,
  ApplyRetentionResponse,
  MemoryWeightingConfig,
} from './interfaces/index.js';
export { DEFAULT_WEIGHTING_CONFIG } from './interfaces/index.js';
