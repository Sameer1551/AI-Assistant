/**
 * Plugin data models for the Plugin_Service.
 *
 * The Plugin_Service manages sandboxed plugin execution with declared permission
 * manifests, code signing verification, resource limits, and plugin registry management.
 *
 * @module plugin
 */

/**
 * Permissions that a plugin can request in its manifest.
 */
export type PluginPermission =
  | 'network_outbound'
  | 'speak'
  | 'file_read'
  | 'file_write'
  | 'os_control'
  | 'browser_control';

/**
 * A declarative specification of a plugin's identity, version, permissions,
 * entry point, and trigger phrases. Required for plugin registration and execution.
 */
export interface PluginManifest {
  /** Unique identifier for this plugin */
  readonly plugin_id: string;
  /** Human-readable name of the plugin */
  readonly name: string;
  /** Semantic version string */
  readonly version: string;
  /** Description of what the plugin does */
  readonly description: string;
  /** Author or organization that created the plugin */
  readonly author: string;
  /** Permissions the plugin requires to operate */
  readonly permissions: readonly PluginPermission[];
  /** Module entry point for plugin execution */
  readonly entry_point: string;
  /** Natural language phrases that trigger this plugin */
  readonly trigger_phrases: readonly string[];
  /** Cryptographic signature of the plugin code */
  readonly code_signature: string;
  /** Whether the code signature has been verified */
  readonly signature_verified: boolean;
  /** Maximum execution time in seconds (default 15) */
  readonly max_execution_seconds: number;
}

/**
 * Result of executing a plugin, including outcome, resource usage, and audit trail.
 */
export interface PluginExecutionResult {
  /** Unique identifier for this execution */
  readonly execution_id: string;
  /** The plugin that was executed */
  readonly plugin_id: string;
  /** Version of the plugin that was executed */
  readonly plugin_version: string;
  /** Outcome of the execution */
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'PERMISSION_DENIED';
  /** Output produced by the plugin, if successful */
  readonly output?: unknown;
  /** Error message, if execution failed */
  readonly error?: string;
  /** Permissions actually used during execution */
  readonly permissions_used: readonly PluginPermission[];
  /** Time taken to execute in milliseconds */
  readonly execution_duration_ms: number;
  /** Resource consumption during execution */
  readonly resource_usage: PluginResourceUsage;
  /** Audit event ID for traceability */
  readonly audit_event_id: string;
}

/**
 * Resource consumption metrics for a plugin execution.
 */
export interface PluginResourceUsage {
  /** Peak memory usage in megabytes */
  readonly peak_memory_mb: number;
  /** CPU time consumed in milliseconds */
  readonly cpu_time_ms: number;
}
