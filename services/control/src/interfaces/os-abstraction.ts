/**
 * OS abstraction layer interfaces.
 *
 * Translates Action requests into platform-specific operations for
 * Windows, macOS, and Linux, such that Action definitions are portable
 * across supported operating systems.
 */

/**
 * Supported operating system platforms.
 */
export type OSPlatform = 'windows' | 'macos' | 'linux';

/**
 * Result of an OS-specific operation.
 */
export interface OSOperationResult {
  /** Whether the operation succeeded */
  readonly success: boolean;
  /** Result data (platform-specific) */
  readonly data?: unknown;
  /** Error message if failed */
  readonly error?: string;
}

/**
 * Interface for platform-specific action execution.
 */
export interface IOSAdapter {
  /** The platform this adapter handles */
  readonly platform: OSPlatform;

  /**
   * Execute a file system operation.
   * @param operation - The operation type (create, delete, move, copy)
   * @param params - Operation parameters
   */
  executeFileOperation(operation: string, params: Record<string, unknown>): Promise<OSOperationResult>;

  /**
   * Execute a process/application operation.
   * @param operation - The operation type (launch, close, focus)
   * @param params - Operation parameters
   */
  executeProcessOperation(operation: string, params: Record<string, unknown>): Promise<OSOperationResult>;

  /**
   * Execute a UI automation operation.
   * @param operation - The operation type (click, type, scroll)
   * @param params - Operation parameters
   */
  executeUIOperation(operation: string, params: Record<string, unknown>): Promise<OSOperationResult>;
}

/**
 * Service that routes operations to the correct OS adapter.
 */
export interface IOSAbstractionLayer {
  /**
   * Get the current platform.
   */
  getCurrentPlatform(): OSPlatform;

  /**
   * Execute an operation using the appropriate platform adapter.
   * @param category - Operation category (file, process, ui)
   * @param operation - Specific operation
   * @param params - Operation parameters
   */
  execute(category: string, operation: string, params: Record<string, unknown>): Promise<OSOperationResult>;

  /**
   * Register a platform adapter.
   * @param adapter - The adapter to register
   */
  registerAdapter(adapter: IOSAdapter): void;
}
