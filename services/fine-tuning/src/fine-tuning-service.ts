/**
 * @module fine-tuning-service
 * Fine_Tuning_Service: Local LoRA fine-tuning and safety gating.
 *
 * @see Requirements 50.1–50.7
 */

import type { LoRAAdapter } from '@may/types';
import type {
  IFineTuningIdGenerator,
  IFineTuningClock,
  IAuditPublisher,
  IBenchmarkEngine,
  IResourceGovernor,
  IFineTuningStore,
  ILoRATrainer,
} from './interfaces/index.js';

export interface FineTuningServiceDeps {
  readonly idGenerator: IFineTuningIdGenerator;
  readonly clock: IFineTuningClock;
  readonly auditPublisher: IAuditPublisher;
  readonly benchmarkEngine: IBenchmarkEngine;
  readonly resourceGovernor: IResourceGovernor;
  readonly store: IFineTuningStore;
  readonly trainer: ILoRATrainer;
}

export class FineTuningService {
  private readonly clock: IFineTuningClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly benchmarkEngine: IBenchmarkEngine;
  private readonly resourceGovernor: IResourceGovernor;
  private readonly store: IFineTuningStore;
  private readonly trainer: ILoRATrainer;

  constructor(deps: FineTuningServiceDeps) {
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.benchmarkEngine = deps.benchmarkEngine;
    this.resourceGovernor = deps.resourceGovernor;
    this.store = deps.store;
    this.trainer = deps.trainer;
  }

  /**
   * Run a local fine-tuning cycle using approved training data.
   *
   * @see Requirement 50.1 (Local only)
   * @see Requirement 50.2 (Review gate - relies on pre-approved data)
   * @see Requirement 50.6 (Throttle Level)
   * @see Requirement 50.7 (Tenant config)
   */
  async runFineTuning(tenantId: string, baseModelId: string): Promise<LoRAAdapter | null> {
    // 1. Throttle Level Gating (Requirement 50.6 / Property 90)
    const throttleLevel = await this.resourceGovernor.getCurrentThrottleLevel();
    if (throttleLevel !== 'NORMAL') {
      return null;
    }

    // 2. Tenant configuration (Requirement 50.7)
    const config = await this.store.getTenantConfig(tenantId);
    if (!config.fineTuningEnabled) {
      return null;
    }

    // 3. Fetch ONLY explicitly approved training data (Requirement 50.2 / Property 88)
    const trainingData = await this.store.getPendingTrainingData(tenantId);
    if (trainingData.length === 0) {
      return null; // Nothing to train on
    }

    // 4. Record pre-training baseline score
    const baselineScore = await this.benchmarkEngine.evaluateBaseline();

    // 5. Run LoRA training (Requirement 50.3 / Property 89)
    // The trainer interface explicitly only returns LoRA weights/adapter details
    const { adapterId, version } = await this.trainer.train(trainingData, baseModelId);

    // 6. Regression benchmark (Requirement 50.5)
    const adapterScore = await this.benchmarkEngine.evaluateWithAdapter(adapterId);

    let isRolledBack = false;
    let isActive = true;

    if (adapterScore < baselineScore) {
      // Auto-rollback on score drop
      isRolledBack = true;
      isActive = false;
      await this.auditPublisher.publishAudit({
        type: 'lora_training_rollback',
        adapterId,
        baselineScore,
        adapterScore,
      });
    }

    const adapter: LoRAAdapter = {
      adapter_id: adapterId,
      version,
      base_model_id: baseModelId,
      training_data_count: trainingData.length,
      benchmark_score: adapterScore,
      pre_training_baseline: baselineScore,
      created_at: this.clock.nowISO(),
      is_active: isActive,
      rolled_back: isRolledBack,
    };

    await this.store.saveAdapter(adapter);
    
    // Mark data as consumed
    await this.store.markTrainingDataReviewed(trainingData.map(d => d.id));

    // Audit
    await this.auditPublisher.publishAudit({
      type: 'lora_training_completed',
      adapterId,
      rolledBack: isRolledBack,
    });

    return adapter;
  }
}
