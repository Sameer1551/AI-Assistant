/**
 * @module vision-service
 * Vision_Service: Screen and webcam analysis with consent gating.
 *
 * - Accept frames only with current consent record for corresponding sensor
 * - Analyze only frames with pixel-difference above change threshold
 * - Classify workflow context into ontology: {coding, browsing, writing, spreadsheet, communication, meeting, media, unknown}
 * - Produce UserPresenceState every ≤5s
 * - Discard biometric frames when tenant hasn't enabled biometric processing
 * - Never persist raw frames beyond analysis duration
 * - Support Offline_Mode with tenant-boundary models
 *
 * @see Requirements 3.1–3.7
 */

// ─── Ontology ─────────────────────────────────────────────────────────────────

export type WorkflowContext =
  | 'coding'
  | 'browsing'
  | 'writing'
  | 'spreadsheet'
  | 'communication'
  | 'meeting'
  | 'media'
  | 'unknown';

export const WORKFLOW_CONTEXT_ONTOLOGY: ReadonlySet<WorkflowContext> = new Set([
  'coding', 'browsing', 'writing', 'spreadsheet',
  'communication', 'meeting', 'media', 'unknown',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FrameAnalysisRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly consent_record_id: string;
  readonly sensor: 'screen' | 'webcam';
  readonly frame: Uint8Array;
  readonly previous_frame?: Uint8Array;
  readonly change_threshold?: number;
  readonly biometric_processing_enabled: boolean;
  readonly offline_mode?: boolean;
}

export interface WorkflowContextResult {
  readonly context: WorkflowContext;
  readonly confidence: number;
  readonly analyzed_at: string;
}

export interface UserPresenceState {
  readonly presence: 'present' | 'absent' | 'unknown';
  readonly gaze: 'screen' | 'away' | 'unknown';
  readonly eye_openness: number;           // [0,1]
  readonly head_pose: 'forward' | 'down' | 'up' | 'side' | 'unknown';
  readonly time_in_state_seconds: number;
  readonly produced_at: string;
}

export interface IVisionAnalyzer {
  classifyWorkflowContext(frame: Uint8Array, offline: boolean): Promise<{
    context: WorkflowContext;
    confidence: number;
  }>;
  detectPresence(frame: Uint8Array, offline: boolean): Promise<Omit<UserPresenceState, 'produced_at' | 'time_in_state_seconds'>>;
  computePixelDifference(frameA: Uint8Array, frameB: Uint8Array): number;
}

export interface IVisionConsentValidator {
  isValid(consentRecordId: string, tenantId: string, principalId: string, sensor: string): Promise<boolean>;
}

export interface IVisionClock {
  nowISO(): string;
}

export interface IVisionAuditEmitter {
  emit(event: { event_type: string; tenant_id: string; principal_id: string; details?: Record<string, unknown> }): Promise<void>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface VisionServiceDeps {
  readonly analyzer: IVisionAnalyzer;
  readonly consentValidator: IVisionConsentValidator;
  readonly clock: IVisionClock;
  readonly auditEmitter: IVisionAuditEmitter;
  readonly changeThreshold?: number;
}

export class VisionService {
  private readonly analyzer: IVisionAnalyzer;
  private readonly consentValidator: IVisionConsentValidator;
  private readonly clock: IVisionClock;
  private readonly auditEmitter: IVisionAuditEmitter;
  private readonly changeThreshold: number;

  /** Track time_in_state per principal */
  private readonly stateTimers = new Map<string, { state: string; since: number }>();

  constructor(deps: VisionServiceDeps) {
    this.analyzer = deps.analyzer;
    this.consentValidator = deps.consentValidator;
    this.clock = deps.clock;
    this.auditEmitter = deps.auditEmitter;
    this.changeThreshold = deps.changeThreshold ?? 0.05; // 5% pixel difference threshold
  }

  /**
   * Analyze a frame for workflow context.
   *
   * Enforces:
   * 1. Consent gating — reject frames without valid consent
   * 2. Change threshold — skip frames with no significant change
   * 3. Biometric discard — discard if tenant has disabled biometric processing
   *
   * @see Requirement 3.1 — consent gating
   * @see Requirement 3.2 — analyze only frames with pixel-difference above threshold
   * @see Requirement 3.3 — discard biometric frames when disabled
   * @see Requirement 3.5 — classify into ontology
   */
  async analyzeFrame(request: FrameAnalysisRequest): Promise<WorkflowContextResult | null> {
    const { tenant_id, principal_id, consent_record_id, sensor, frame, previous_frame, biometric_processing_enabled, offline_mode = false } = request;

    // 1. Consent gating (Requirement 3.1)
    const hasConsent = await this.consentValidator.isValid(
      consent_record_id, tenant_id, principal_id, sensor,
    );
    if (!hasConsent) {
      // Never process frames without consent
      return null;
    }

    // 2. Biometric discard — if biometric processing disabled, discard without identification (Req 3.3)
    if (sensor === 'webcam' && !biometric_processing_enabled) {
      await this.auditEmitter.emit({
        event_type: 'vision.biometric_frame_discarded',
        tenant_id,
        principal_id,
        details: { reason: 'biometric_processing_disabled' },
      });
      // Raw frames must not persist beyond this point
      return null;
    }

    // 3. Change threshold — skip unchanged frames (Requirement 3.2)
    if (previous_frame && previous_frame.length > 0) {
      const diff = this.analyzer.computePixelDifference(frame, previous_frame);
      if (diff < this.changeThreshold) {
        return null; // No significant change
      }
    }

    // 4. Classify workflow context (must be from ontology — Requirement 3.5)
    const { context, confidence } = await this.analyzer.classifyWorkflowContext(frame, offline_mode);

    // Guarantee result is within ontology
    const safeContext: WorkflowContext = WORKFLOW_CONTEXT_ONTOLOGY.has(context) ? context : 'unknown';

    // NOTE: raw frame is not persisted beyond this function call (Requirement 3.7)
    return {
      context: safeContext,
      confidence,
      analyzed_at: this.clock.nowISO(),
    };
  }

  /**
   * Produce UserPresenceState from a webcam frame.
   *
   * @see Requirement 3.4 — UserPresenceState every ≤5s
   */
  async detectPresence(request: FrameAnalysisRequest): Promise<UserPresenceState | null> {
    const { tenant_id, principal_id, consent_record_id, biometric_processing_enabled, frame, offline_mode = false } = request;

    // Consent gating
    const hasConsent = await this.consentValidator.isValid(
      consent_record_id, tenant_id, principal_id, 'webcam',
    );
    if (!hasConsent) return null;

    // Biometric discard
    if (!biometric_processing_enabled) {
      await this.auditEmitter.emit({
        event_type: 'vision.biometric_frame_discarded',
        tenant_id,
        principal_id,
        details: { reason: 'biometric_processing_disabled' },
      });
      return null;
    }

    const presenceData = await this.analyzer.detectPresence(frame, offline_mode);
    const now = this.clock.nowISO();

    // Track time_in_state
    const key = `${tenant_id}:${principal_id}`;
    const nowMs = new Date(now).getTime();
    const prev = this.stateTimers.get(key);
    let timeInState = 0;

    if (prev && prev.state === presenceData.presence) {
      timeInState = Math.floor((nowMs - prev.since) / 1000);
    } else {
      this.stateTimers.set(key, { state: presenceData.presence, since: nowMs });
    }

    return {
      ...presenceData,
      time_in_state_seconds: timeInState,
      produced_at: now,
    };
  }
}
