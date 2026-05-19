/**
 * Unit tests for OSAbstractionLayer.
 *
 * Verifies:
 * - Platform detection and routing (Requirement 2.13)
 * - Adapter registration and delegation
 * - Error handling for missing adapters and unknown categories
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OSAbstractionLayer } from '../src/os-abstraction-layer.js';
import type { IOSAdapter, OSOperationResult } from '../src/interfaces/index.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockWindowsAdapter implements IOSAdapter {
  readonly platform = 'windows' as const;
  readonly calls: Array<{ category: string; operation: string; params: Record<string, unknown> }> = [];

  async executeFileOperation(operation: string, params: Record<string, unknown>): Promise<OSOperationResult> {
    this.calls.push({ category: 'file', operation, params });
    return { success: true, data: { platform: 'windows', operation } };
  }

  async executeProcessOperation(operation: string, params: Record<string, unknown>): Promise<OSOperationResult> {
    this.calls.push({ category: 'process', operation, params });
    return { success: true, data: { platform: 'windows', operation } };
  }

  async executeUIOperation(operation: string, params: Record<string, unknown>): Promise<OSOperationResult> {
    this.calls.push({ category: 'ui', operation, params });
    return { success: true, data: { platform: 'windows', operation } };
  }
}

class MockLinuxAdapter implements IOSAdapter {
  readonly platform = 'linux' as const;

  async executeFileOperation(operation: string, _params: Record<string, unknown>): Promise<OSOperationResult> {
    return { success: true, data: { platform: 'linux', operation } };
  }

  async executeProcessOperation(operation: string, _params: Record<string, unknown>): Promise<OSOperationResult> {
    return { success: true, data: { platform: 'linux', operation } };
  }

  async executeUIOperation(operation: string, _params: Record<string, unknown>): Promise<OSOperationResult> {
    return { success: true, data: { platform: 'linux', operation } };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OSAbstractionLayer', () => {
  let layer: OSAbstractionLayer;
  let windowsAdapter: MockWindowsAdapter;

  beforeEach(() => {
    layer = new OSAbstractionLayer('windows');
    windowsAdapter = new MockWindowsAdapter();
    layer.registerAdapter(windowsAdapter);
  });

  describe('getCurrentPlatform', () => {
    it('should return the configured platform', () => {
      expect(layer.getCurrentPlatform()).toBe('windows');
    });

    it('should accept different platforms', () => {
      const linuxLayer = new OSAbstractionLayer('linux');
      expect(linuxLayer.getCurrentPlatform()).toBe('linux');

      const macLayer = new OSAbstractionLayer('macos');
      expect(macLayer.getCurrentPlatform()).toBe('macos');
    });
  });

  describe('execute', () => {
    it('should route file operations to the correct adapter', async () => {
      const result = await layer.execute('file', 'delete', { path: '/tmp/test.txt' });

      expect(result.success).toBe(true);
      expect(windowsAdapter.calls).toHaveLength(1);
      expect(windowsAdapter.calls[0]).toEqual({
        category: 'file',
        operation: 'delete',
        params: { path: '/tmp/test.txt' },
      });
    });

    it('should route process operations to the correct adapter', async () => {
      const result = await layer.execute('process', 'launch', { app: 'notepad' });

      expect(result.success).toBe(true);
      expect(windowsAdapter.calls[0].category).toBe('process');
      expect(windowsAdapter.calls[0].operation).toBe('launch');
    });

    it('should route UI operations to the correct adapter', async () => {
      const result = await layer.execute('ui', 'click', { x: 100, y: 200 });

      expect(result.success).toBe(true);
      expect(windowsAdapter.calls[0].category).toBe('ui');
      expect(windowsAdapter.calls[0].operation).toBe('click');
    });

    it('should return error for unknown operation category', async () => {
      const result = await layer.execute('network', 'connect', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown operation category');
    });

    it('should return error when no adapter is registered for the platform', async () => {
      const linuxLayer = new OSAbstractionLayer('linux');
      // No adapter registered

      const result = await linuxLayer.execute('file', 'delete', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No adapter registered');
    });

    it('should use the adapter matching the current platform', async () => {
      const linuxLayer = new OSAbstractionLayer('linux');
      const linuxAdapter = new MockLinuxAdapter();
      linuxLayer.registerAdapter(linuxAdapter);

      const result = await linuxLayer.execute('file', 'create', { path: '/tmp/new.txt' });

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['platform']).toBe('linux');
    });
  });

  describe('registerAdapter', () => {
    it('should allow registering multiple adapters for different platforms', async () => {
      const linuxAdapter = new MockLinuxAdapter();
      layer.registerAdapter(linuxAdapter);

      // Windows adapter still works
      const winResult = await layer.execute('file', 'delete', {});
      expect(winResult.success).toBe(true);
    });

    it('should override existing adapter for the same platform', async () => {
      const newWindowsAdapter = new MockWindowsAdapter();
      layer.registerAdapter(newWindowsAdapter);

      await layer.execute('file', 'delete', {});

      // New adapter should have the call, not the old one
      expect(newWindowsAdapter.calls).toHaveLength(1);
      expect(windowsAdapter.calls).toHaveLength(0);
    });
  });
});
