/**
 * OS abstraction layer implementation.
 *
 * Translates Action requests into platform-specific operations for
 * Windows, macOS, and Linux. Action definitions are portable across
 * supported operating systems.
 *
 * @module os-abstraction-layer
 */

import type {
  OSPlatform,
  OSOperationResult,
  IOSAdapter,
  IOSAbstractionLayer,
} from './interfaces/index.js';

/**
 * Detects the current operating system platform.
 */
export function detectPlatform(): OSPlatform {
  const platform = process.platform;
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'linux'; // Default to linux for unknown platforms
  }
}

/**
 * OS abstraction layer that routes operations to platform-specific adapters.
 *
 * Maintains a registry of adapters per platform and delegates operations
 * to the adapter matching the current platform.
 */
export class OSAbstractionLayer implements IOSAbstractionLayer {
  private readonly adapters = new Map<OSPlatform, IOSAdapter>();
  private readonly platform: OSPlatform;

  constructor(platform?: OSPlatform) {
    this.platform = platform ?? detectPlatform();
  }

  getCurrentPlatform(): OSPlatform {
    return this.platform;
  }

  registerAdapter(adapter: IOSAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  async execute(
    category: string,
    operation: string,
    params: Record<string, unknown>,
  ): Promise<OSOperationResult> {
    const adapter = this.adapters.get(this.platform);
    if (!adapter) {
      return {
        success: false,
        error: `No adapter registered for platform: ${this.platform}`,
      };
    }

    switch (category) {
      case 'file':
        return adapter.executeFileOperation(operation, params);
      case 'process':
        return adapter.executeProcessOperation(operation, params);
      case 'ui':
        return adapter.executeUIOperation(operation, params);
      default:
        return {
          success: false,
          error: `Unknown operation category: ${category}`,
        };
    }
  }
}
