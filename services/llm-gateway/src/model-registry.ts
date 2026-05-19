/**
 * In-memory Model Registry implementation with versioning.
 *
 * Provides CRUD operations for ModelRegistryEntry with automatic version
 * management and timestamp tracking. Supports filtering by provider,
 * approval status, capability tags, and residency constraints.
 *
 * @see Requirement 4.2 — versioned Model_Registry
 */

import type { ModelRegistryEntry } from '@may/types';
import type {
  IModelRegistry,
  IClock,
  IIdGenerator,
  ModelRegistryCreateInput,
  ModelRegistryUpdateInput,
  ModelRegistryListOptions,
  ModelRegistryMutationResult,
} from './interfaces/index.js';
import type { VersionedEntry } from './types/index.js';

/**
 * In-memory implementation of the Model Registry.
 *
 * Stores versioned model entries in a Map keyed by model_id.
 * Each mutation increments the version and updates timestamps.
 * Thread-safe for single-process use (Node.js event loop).
 */
export class ModelRegistry implements IModelRegistry {
  private readonly store = new Map<string, VersionedEntry<ModelRegistryEntry>>();

  constructor(
    private readonly clock: IClock,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async get(modelId: string): Promise<ModelRegistryEntry | null> {
    const versioned = this.store.get(modelId);
    return versioned?.current ?? null;
  }

  async list(options?: ModelRegistryListOptions): Promise<readonly ModelRegistryEntry[]> {
    let entries = Array.from(this.store.values()).map((v) => v.current);

    if (options?.provider !== undefined) {
      entries = entries.filter((e) => e.provider === options.provider);
    }

    if (options?.approval_status !== undefined) {
      entries = entries.filter((e) => e.approval_status === options.approval_status);
    }

    if (options?.capability_tag !== undefined) {
      const tag = options.capability_tag;
      entries = entries.filter((e) => e.capability_tags.includes(tag));
    }

    if (options?.residency_region !== undefined) {
      const region = options.residency_region;
      entries = entries.filter((e) => e.residency_constraints.includes(region));
    }

    return entries;
  }

  async create(input: ModelRegistryCreateInput): Promise<ModelRegistryMutationResult> {
    if (this.store.has(input.model_id)) {
      throw new Error(`Model registry entry already exists: ${input.model_id}`);
    }

    const now = this.clock.nowISO();
    const version = this.idGenerator.version();

    const entry: ModelRegistryEntry = {
      model_id: input.model_id,
      provider: input.provider,
      identifier: input.identifier,
      capability_tags: [...input.capability_tags],
      cost_coefficients: { ...input.cost_coefficients },
      residency_constraints: [...input.residency_constraints],
      approval_status: input.approval_status,
      version,
      fallback_chain: [...input.fallback_chain],
      circuit_breaker_config: { ...input.circuit_breaker_config },
      canary_config: {
        ...input.canary_config,
        progression_schedule: [...input.canary_config.progression_schedule],
        health_tolerances: { ...input.canary_config.health_tolerances },
      },
      created_at: now,
      updated_at: now,
    };

    this.store.set(input.model_id, { current: entry, version_number: 1 });

    return { entry };
  }

  async update(modelId: string, updates: ModelRegistryUpdateInput): Promise<ModelRegistryMutationResult> {
    const existing = this.store.get(modelId);
    if (!existing) {
      throw new Error(`Model registry entry not found: ${modelId}`);
    }

    const previousVersion = existing.current.version;
    const now = this.clock.nowISO();
    const newVersion = this.idGenerator.version();

    const updated: ModelRegistryEntry = {
      model_id: existing.current.model_id,
      provider: updates.provider ?? existing.current.provider,
      identifier: updates.identifier ?? existing.current.identifier,
      capability_tags: updates.capability_tags
        ? [...updates.capability_tags]
        : existing.current.capability_tags,
      cost_coefficients: updates.cost_coefficients
        ? { ...updates.cost_coefficients }
        : existing.current.cost_coefficients,
      residency_constraints: updates.residency_constraints
        ? [...updates.residency_constraints]
        : existing.current.residency_constraints,
      approval_status: updates.approval_status ?? existing.current.approval_status,
      version: newVersion,
      fallback_chain: updates.fallback_chain
        ? [...updates.fallback_chain]
        : existing.current.fallback_chain,
      circuit_breaker_config: updates.circuit_breaker_config
        ? { ...updates.circuit_breaker_config }
        : existing.current.circuit_breaker_config,
      canary_config: updates.canary_config
        ? {
            ...updates.canary_config,
            progression_schedule: [...updates.canary_config.progression_schedule],
            health_tolerances: { ...updates.canary_config.health_tolerances },
          }
        : existing.current.canary_config,
      created_at: existing.current.created_at,
      updated_at: now,
    };

    this.store.set(modelId, {
      current: updated,
      version_number: existing.version_number + 1,
    });

    return { entry: updated, previous_version: previousVersion };
  }

  async delete(modelId: string): Promise<boolean> {
    return this.store.delete(modelId);
  }
}
