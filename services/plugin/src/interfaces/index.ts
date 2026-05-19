import type { PluginManifest, PluginPermission } from '@may/types';

export interface IPluginIdGenerator {
  uuid(): string;
}

export interface IPluginClock {
  nowISO(): string;
  nowMs(): number;
}

export interface IAuditPublisher {
  publishAudit(event: any): Promise<void>;
}

export interface IOutputFilter {
  sanitize(output: any): any;
}

export interface ISignatureVerifier {
  verify(pluginId: string, signature: string, code: string): boolean;
}

export interface IPluginExecutor {
  execute(
    manifest: PluginManifest,
    code: string,
    inputs: Record<string, any>,
    grantedPermissions: readonly PluginPermission[]
  ): Promise<{ output: any; usedPermissions: PluginPermission[]; resourceUsage: { peak_memory_mb: number; cpu_time_ms: number } }>;
}
