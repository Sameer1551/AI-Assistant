/**
 * Unit tests for DryRunPreviewService.
 *
 * Verifies:
 * - Preview generation for actions (Requirement 2.14)
 * - Custom predictor registration and usage
 * - Default predictor fallback behavior
 * - Risk assessment generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DryRunPreviewService } from '../src/dry-run-preview-service.js';
import type { IEffectPredictor, IClock } from '../src/interfaces/index.js';
import type { ActionRequest } from '@may/types';
import type { PredictedEffect, Reversibility } from '@may/types';
import type { ActionId, IdempotencyKey, TenantId, PrincipalId, CorrelationId, SessionId } from '@may/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

class MockClock implements IClock {
  private currentTime = '2024-01-15T10:00:00.000Z';

  nowISO(): string {
    return this.currentTime;
  }

  setTime(iso: string): void {
    this.currentTime = iso;
  }
}

function makeActionRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action_id: 'action-001' as ActionId,
    idempotency_key: 'idem-001' as IdempotencyKey,
    risk_level: 'MEDIUM',
    action_type: 'file.delete',
    parameters: { path: '/tmp/test.txt' },
    timeout_seconds: 60,
    context: {
      tenant_id: 'tenant-001' as TenantId,
      principal_id: 'user-001' as PrincipalId,
      correlation_id: 'corr-001' as CorrelationId,
      trace_context: { traceparent: '00-trace-001-span-001-01' },
      session_id: 'session-001' as SessionId,
      roles: ['End_User'],
      attributes: {},
      residency_region: 'us-east-1',
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DryRunPreviewService', () => {
  let service: DryRunPreviewService;
  let clock: MockClock;

  beforeEach(() => {
    clock = new MockClock();
    service = new DryRunPreviewService({ clock });
  });

  describe('generatePreview', () => {
    it('should generate a preview using the default predictor when no specific predictor is registered', async () => {
      const request = makeActionRequest();
      const result = await service.generatePreview(request);

      expect(result.action_id).toBe('action-001');
      expect(result.predicted_effects).toHaveLength(1);
      expect(result.predicted_effects[0].description).toContain('file.delete');
      expect(result.reversibility).toBe('partially_reversible');
      expect(result.affected_resources).toContain('file.delete');
      expect(result.affected_resources).toContain('/tmp/test.txt');
      expect(result.timestamp).toBe('2024-01-15T10:00:00.000Z');
    });

    it('should use a registered predictor for the matching action type', async () => {
      const customPredictor: IEffectPredictor = {
        action_type: 'file.delete',
        async predictEffects(_request: ActionRequest): Promise<PredictedEffect[]> {
          return [
            {
              description: 'File will be permanently deleted',
              resource: '/tmp/test.txt',
              change_type: 'delete',
              confidence: 0.99,
            },
          ];
        },
        async assessReversibility(_request: ActionRequest): Promise<Reversibility> {
          return 'irreversible';
        },
        async identifyAffectedResources(_request: ActionRequest): Promise<string[]> {
          return ['/tmp/test.txt'];
        },
      };

      service.registerPredictor(customPredictor);
      const request = makeActionRequest();
      const result = await service.generatePreview(request);

      expect(result.predicted_effects[0].description).toBe('File will be permanently deleted');
      expect(result.predicted_effects[0].confidence).toBe(0.99);
      expect(result.reversibility).toBe('irreversible');
      expect(result.affected_resources).toEqual(['/tmp/test.txt']);
      expect(result.risk_assessment).toContain('cannot be reversed');
    });

    it('should generate appropriate risk assessment for MEDIUM risk', async () => {
      const request = makeActionRequest({ risk_level: 'MEDIUM' });
      const result = await service.generatePreview(request);

      expect(result.risk_assessment).toContain('moderate');
    });

    it('should generate appropriate risk assessment for HIGH risk', async () => {
      const request = makeActionRequest({ risk_level: 'HIGH' });
      const result = await service.generatePreview(request);

      expect(result.risk_assessment).toContain('high');
    });

    it('should generate appropriate risk assessment for CRITICAL risk', async () => {
      const request = makeActionRequest({ risk_level: 'CRITICAL' });
      const result = await service.generatePreview(request);

      expect(result.risk_assessment).toContain('critical');
    });

    it('should include URL in affected resources when present in parameters', async () => {
      const request = makeActionRequest({
        action_type: 'browser.navigate',
        parameters: { url: 'https://example.com' },
      });
      const result = await service.generatePreview(request);

      expect(result.affected_resources).toContain('https://example.com');
    });

    it('should include target in affected resources when present in parameters', async () => {
      const request = makeActionRequest({
        action_type: 'app.focus',
        parameters: { target: 'vscode' },
      });
      const result = await service.generatePreview(request);

      expect(result.affected_resources).toContain('vscode');
    });

    it('should use the current timestamp from the clock', async () => {
      clock.setTime('2024-06-01T15:30:00.000Z');
      const request = makeActionRequest();
      const result = await service.generatePreview(request);

      expect(result.timestamp).toBe('2024-06-01T15:30:00.000Z');
    });
  });

  describe('hasPredictor', () => {
    it('should return false when no predictor is registered', () => {
      expect(service.hasPredictor('file.delete')).toBe(false);
    });

    it('should return true after registering a predictor', () => {
      const predictor: IEffectPredictor = {
        action_type: 'file.delete',
        async predictEffects(): Promise<PredictedEffect[]> { return []; },
        async assessReversibility(): Promise<Reversibility> { return 'fully_reversible'; },
        async identifyAffectedResources(): Promise<string[]> { return []; },
      };
      service.registerPredictor(predictor);
      expect(service.hasPredictor('file.delete')).toBe(true);
    });
  });
});
