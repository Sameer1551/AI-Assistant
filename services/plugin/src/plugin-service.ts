/**
 * @module plugin-service
 * Plugin_Service: Sandboxed execution with permissions and signatures.
 *
 * @see Requirements 48.1–48.8
 */

import type { PluginManifest, PluginExecutionResult, PluginPermission } from '@may/types';
import type {
  IPluginIdGenerator,
  IPluginClock,
  IAuditPublisher,
  IOutputFilter,
  ISignatureVerifier,
  IPluginExecutor,
} from './interfaces/index.js';

export interface PluginServiceDeps {
  readonly idGenerator: IPluginIdGenerator;
  readonly clock: IPluginClock;
  readonly auditPublisher: IAuditPublisher;
  readonly outputFilter: IOutputFilter;
  readonly signatureVerifier: ISignatureVerifier;
  readonly executor: IPluginExecutor;
}

export class PluginService {
  private readonly idGenerator: IPluginIdGenerator;
  private readonly clock: IPluginClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly outputFilter: IOutputFilter;
  private readonly signatureVerifier: ISignatureVerifier;
  private readonly executor: IPluginExecutor;

  // Mock registry for tenant approvals
  private tenantRegistry = new Map<string, Set<string>>();

  constructor(deps: PluginServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.outputFilter = deps.outputFilter;
    this.signatureVerifier = deps.signatureVerifier;
    this.executor = deps.executor;
  }

  approvePluginForTenant(tenantId: string, pluginId: string) {
    const set = this.tenantRegistry.get(tenantId) ?? new Set<string>();
    set.add(pluginId);
    this.tenantRegistry.set(tenantId, set);
  }

  isPluginApproved(tenantId: string, pluginId: string): boolean {
    return this.tenantRegistry.get(tenantId)?.has(pluginId) ?? false;
  }

  /**
   * Execute a plugin in a sandboxed context.
   */
  async executePlugin(
    tenantId: string,
    manifest: PluginManifest,
    code: string,
    inputs: Record<string, any>
  ): Promise<PluginExecutionResult> {
    const executionId = this.idGenerator.uuid();
    const startMs = this.clock.nowMs();
    
    // 1. Check registry approval
    if (!this.isPluginApproved(tenantId, manifest.plugin_id)) {
      return this.rejectExecution(executionId, manifest, 'PERMISSION_DENIED', 'Plugin is not approved for this tenant.', startMs);
    }

    // 2. Code signature verification (Requirement 48.4, Property 81)
    if (!manifest.code_signature || !this.signatureVerifier.verify(manifest.plugin_id, manifest.code_signature, code)) {
      return this.rejectExecution(executionId, manifest, 'PERMISSION_DENIED', 'Invalid or missing code signature.', startMs);
    }

    // 3. Extract permissions (Requirement 48.3, Property 80)
    // Implicit: Only declared permissions are passed to the executor
    const grantedPermissions = manifest.permissions;

    // 4. Execution with timeout (Requirement 48.5, Property 82)
    const timeoutSeconds = manifest.max_execution_seconds || 15;
    let executorResult: { output: any; usedPermissions: PluginPermission[]; resourceUsage: { peak_memory_mb: number; cpu_time_ms: number } } | undefined;
    let errorMsg: string | undefined;
    let timedOut = false;

    try {
      executorResult = await Promise.race([
        this.executor.execute(manifest, code, inputs, grantedPermissions),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutSeconds * 1000))
      ]);
      
      if (!executorResult) {
        timedOut = true;
      }
    } catch (e: any) {
      errorMsg = e.message ?? 'Unknown error';
    }

    const elapsedMs = this.clock.nowMs() - startMs;

    let result: PluginExecutionResult;
    if (timedOut) {
      result = {
        execution_id: executionId,
        plugin_id: manifest.plugin_id,
        plugin_version: manifest.version,
        outcome: 'TIMEOUT',
        error: `Execution exceeded max time of ${timeoutSeconds}s`,
        permissions_used: [],
        execution_duration_ms: elapsedMs,
        resource_usage: { peak_memory_mb: 0, cpu_time_ms: 0 },
        audit_event_id: this.idGenerator.uuid(),
      };
    } else if (errorMsg) {
      result = {
        execution_id: executionId,
        plugin_id: manifest.plugin_id,
        plugin_version: manifest.version,
        outcome: 'FAILURE',
        error: errorMsg,
        permissions_used: [],
        execution_duration_ms: elapsedMs,
        resource_usage: { peak_memory_mb: 0, cpu_time_ms: 0 },
        audit_event_id: this.idGenerator.uuid(),
      };
    } else {
      // 5. Output Filtering (Requirement 48.6, Property 83)
      const safeOutput = this.outputFilter.sanitize(executorResult!.output);
      
      result = {
        execution_id: executionId,
        plugin_id: manifest.plugin_id,
        plugin_version: manifest.version,
        outcome: 'SUCCESS',
        output: safeOutput,
        permissions_used: executorResult!.usedPermissions,
        execution_duration_ms: elapsedMs,
        resource_usage: executorResult!.resourceUsage,
        audit_event_id: this.idGenerator.uuid(),
      };
    }

    // 6. Audit Logging (Requirement 48.7)
    await this.auditPublisher.publishAudit({
      type: 'plugin_execution',
      tenantId,
      result,
    });

    return result;
  }

  private rejectExecution(executionId: string, manifest: PluginManifest, outcome: 'PERMISSION_DENIED', error: string, startMs: number): PluginExecutionResult {
    return {
      execution_id: executionId,
      plugin_id: manifest.plugin_id,
      plugin_version: manifest.version,
      outcome,
      error,
      permissions_used: [],
      execution_duration_ms: this.clock.nowMs() - startMs,
      resource_usage: { peak_memory_mb: 0, cpu_time_ms: 0 },
      audit_event_id: this.idGenerator.uuid(),
    };
  }
}
