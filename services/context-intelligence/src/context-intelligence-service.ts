/**
 * @module context-intelligence-service
 * Context_Intelligence_Service: Assemble context packets for LLM injection.
 *
 * @see Requirements 36.1–36.7
 */

import type { ContextPacket, ContextField } from '@may/types';
import { toUnitScore } from '@may/types';
import type { IContextProvider, IContextIdGenerator, IContextClock } from './interfaces/index.js';

export interface ContextIntelligenceDeps {
  readonly idGenerator: IContextIdGenerator;
  readonly clock: IContextClock;
  readonly providerTimeoutMs?: number;
}

export class ContextIntelligenceService {
  private readonly idGenerator: IContextIdGenerator;
  private readonly clock: IContextClock;
  private readonly providerTimeoutMs: number;
  private readonly providers = new Map<string, IContextProvider>();

  // Cache: providerId -> fieldName -> { value, confidence }
  private readonly cache = new Map<string, Map<string, { value: unknown; confidence: number }>>();

  constructor(deps: ContextIntelligenceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.providerTimeoutMs = deps.providerTimeoutMs ?? 5000; // Requirement 36.4 (provider timeout >5s)
  }

  registerProvider(provider: IContextProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  async assembleContext(tenantId: string, principalId: string): Promise<ContextPacket> {
    const startTime = Date.now();
    const packetId = this.idGenerator.uuid();
    const timestamp = this.clock.nowISO();
    const fields: ContextField[] = [];

    const providerPromises = Array.from(this.providers.values()).map(async (provider) => {
      let data: Record<string, { value: unknown; confidence: number }> | null = null;
      let isTimeout = false;

      try {
        data = await Promise.race([
          provider.fetchContext(tenantId, principalId),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), this.providerTimeoutMs)),
        ]);
      } catch (e) {
        isTimeout = (e instanceof Error && e.message === 'TIMEOUT');
      }

      let providerCache = this.cache.get(provider.providerId);
      if (!providerCache) {
        providerCache = new Map();
        this.cache.set(provider.providerId, providerCache);
      }

      for (const fieldName of provider.fields) {
        let value: unknown = null;
        let confidence = 0.0;
        let isCached = false;
        let uncertaintyAnnotation: string | undefined;

        if (data && fieldName in data) {
          // Success case
          value = data[fieldName]!.value;
          confidence = data[fieldName]!.confidence;
          providerCache.set(fieldName, { value, confidence });
        } else if (isTimeout) {
          // Timeout case (Requirement 36.4: use cached value, reduce confidence by 0.2 clamped to 0.0)
          isCached = true;
          const cachedEntry = providerCache.get(fieldName);
          if (cachedEntry) {
            value = cachedEntry.value;
            confidence = Math.max(0.0, cachedEntry.confidence - 0.2);
            providerCache.set(fieldName, { value, confidence }); // update cache with decayed confidence
          } else {
            confidence = 0.0;
          }
        }

        // Clamp confidence to [0, 1] (Requirement 36.2)
        confidence = Math.max(0.0, Math.min(1.0, confidence));

        // Annotate fields with confidence <0.7 with uncertainty language (Requirement 36.3)
        if (confidence < 0.7) {
          uncertaintyAnnotation = `Uncertain (confidence ${Math.round(confidence * 100)}%): The following context may be stale or inaccurate.`;
        }

        fields.push({
          name: fieldName,
          value,
          confidence_score: toUnitScore(confidence),
          source_provider: provider.providerId,
          is_cached: isCached,
          uncertainty_annotation: uncertaintyAnnotation,
        });
      }
    });

    await Promise.all(providerPromises);

    const assembledDurationMs = Date.now() - startTime;

    return {
      packet_id: packetId,
      tenant_id: tenantId,
      principal_id: principalId,
      timestamp,
      fields,
      assembled_duration_ms: assembledDurationMs,
    };
  }
}
