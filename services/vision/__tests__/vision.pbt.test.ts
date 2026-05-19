/**
 * Property-Based Tests — Vision Service
 *
 * Property 47: Biometric Frame Discard — discard frame, emit audit, return null when biometric disabled
 * Property 48: Workflow Context Classification Ontology — always from defined ontology set
 *
 * @see Requirements 3.3, 3.5
 */

import { describe, it, expect, vi } from 'vitest';
import { VisionService, WORKFLOW_CONTEXT_ONTOLOGY } from '../src/vision-service.js';
import type { IVisionAnalyzer, WorkflowContext } from '../src/vision-service.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

const DUMMY_FRAME = new Uint8Array([1, 2, 3]);

const mockConsentAlwaysValid = {
  async isValid() { return true; },
};

const mockConsentAlwaysInvalid = {
  async isValid() { return false; },
};

const mockClock = { nowISO: () => '2025-01-15T10:00:00.000Z' };

function makeAnalyzerWithContext(context: string): IVisionAnalyzer {
  return {
    async classifyWorkflowContext() {
      return { context: context as WorkflowContext, confidence: 0.9 };
    },
    async detectPresence() {
      return { presence: 'present', gaze: 'screen', eye_openness: 0.8, head_pose: 'forward' };
    },
    computePixelDifference() { return 0.5; },
  };
}

function makeService(
  analyzer: IVisionAnalyzer,
  consentValidator = mockConsentAlwaysValid,
  onAuditEmit?: (event: Record<string, unknown>) => void,
) {
  const auditEmitter = { emit: async (event: Record<string, unknown>) => { onAuditEmit?.(event); } };
  return new VisionService({ analyzer, consentValidator, clock: mockClock, auditEmitter });
}

const baseRequest = {
  tenant_id: 'tenant-1',
  principal_id: 'user-1',
  consent_record_id: 'consent-abc',
  sensor: 'webcam' as const,
  frame: DUMMY_FRAME,
  biometric_processing_enabled: true,
};

// ─── Property 47: Biometric Frame Discard ────────────────────────────────────

describe('Property 47: Biometric Frame Discard', () => {
  it('discards webcam frame and returns null when biometric_processing_enabled is false', async () => {
    const analyzeSpy = vi.fn();
    const analyzer = makeAnalyzerWithContext('coding');

    const auditEvents: unknown[] = [];
    const service = makeService(analyzer, mockConsentAlwaysValid, (e) => auditEvents.push(e));

    const result = await service.analyzeFrame({
      ...baseRequest,
      biometric_processing_enabled: false,
    });

    expect(result).toBeNull();
  });

  it('emits biometric_frame_discarded audit event when biometric processing disabled', async () => {
    const auditEvents: Record<string, unknown>[] = [];
    const service = makeService(
      makeAnalyzerWithContext('coding'),
      mockConsentAlwaysValid,
      (e) => auditEvents.push(e),
    );

    await service.analyzeFrame({ ...baseRequest, biometric_processing_enabled: false });

    const discardEvent = auditEvents.find((e) => e['event_type'] === 'vision.biometric_frame_discarded');
    expect(discardEvent).toBeDefined();
  });

  it('returns null without any identification when biometric processing disabled', async () => {
    const classifySpy = vi.fn();
    const analyzer: IVisionAnalyzer = {
      classifyWorkflowContext: classifySpy,
      detectPresence: vi.fn(),
      computePixelDifference: () => 0.8,
    };
    const service = makeService(analyzer);

    const result = await service.analyzeFrame({ ...baseRequest, biometric_processing_enabled: false });

    expect(result).toBeNull();
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('does not discard frame when biometric_processing_enabled is true', async () => {
    const service = makeService(makeAnalyzerWithContext('coding'));

    const result = await service.analyzeFrame({ ...baseRequest, biometric_processing_enabled: true });

    expect(result).not.toBeNull();
  });

  it('returns null when no valid consent record', async () => {
    const service = makeService(makeAnalyzerWithContext('coding'), mockConsentAlwaysInvalid);
    const result = await service.analyzeFrame(baseRequest);
    expect(result).toBeNull();
  });
});

// ─── Property 48: Workflow Context Classification Ontology ───────────────────

describe('Property 48: Workflow Context Classification Ontology', () => {
  it('classified context is always from the defined ontology set', async () => {
    const validContexts = [...WORKFLOW_CONTEXT_ONTOLOGY];

    for (const ctx of validContexts) {
      const service = makeService(makeAnalyzerWithContext(ctx));
      const result = await service.analyzeFrame({ ...baseRequest, sensor: 'screen' });
      if (result) {
        expect(WORKFLOW_CONTEXT_ONTOLOGY.has(result.context)).toBe(true);
      }
    }
  });

  it('unknown context values from analyzer are mapped to "unknown" in ontology', async () => {
    // Analyzer returns a non-standard context
    const analyzer = makeAnalyzerWithContext('hacking_the_mainframe');
    const service = makeService(analyzer);

    const result = await service.analyzeFrame({ ...baseRequest, sensor: 'screen' });
    if (result) {
      expect(result.context).toBe('unknown');
      expect(WORKFLOW_CONTEXT_ONTOLOGY.has(result.context)).toBe(true);
    }
  });

  it('ontology contains exactly the 8 defined workflow contexts', () => {
    const expected = ['coding', 'browsing', 'writing', 'spreadsheet', 'communication', 'meeting', 'media', 'unknown'];
    expect(WORKFLOW_CONTEXT_ONTOLOGY.size).toBe(8);
    for (const ctx of expected) {
      expect(WORKFLOW_CONTEXT_ONTOLOGY.has(ctx as WorkflowContext)).toBe(true);
    }
  });
});
