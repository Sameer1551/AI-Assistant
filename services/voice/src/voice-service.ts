/**
 * @module voice-service
 * Voice_Service: Speech-to-Text and Text-to-Speech with consent gating.
 *
 * - TranscribeStream with streaming STT, begin within 200ms of first frame after wake event
 * - WER ≤10% target on tenant's primary language
 * - Language identification and confidence score in transcription
 * - Synthesize TTS with latency ≤1500ms at p95 to first audio frame
 * - Offline_Mode with tenant-boundary-only models
 *
 * @see Requirements 1.3, 1.4, 1.5, 1.6, 1.9
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TranscribeRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly audio_frames: readonly Uint8Array[];
  readonly consent_record_id: string;
  readonly offline_mode?: boolean;
}

export interface TranscriptionResult {
  readonly transcript: string;
  readonly language_code: string;
  readonly language_confidence: number;
  readonly word_error_rate_estimate: number;
  readonly is_final: boolean;
  readonly latency_ms: number;
}

export interface SynthesizeRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly text: string;
  readonly voice_id?: string;
  readonly offline_mode?: boolean;
  readonly consent_record_id: string;
}

export interface SynthesisResult {
  readonly audio_frames: Uint8Array[];
  readonly duration_ms: number;
  readonly first_frame_latency_ms: number;
  readonly voice_id: string;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ISTTAdapter {
  transcribe(audioFrames: readonly Uint8Array[], offline: boolean): Promise<{
    transcript: string;
    language_code: string;
    language_confidence: number;
    wer_estimate: number;
    latency_ms: number;
  }>;
}

export interface ITTSAdapter {
  synthesize(text: string, voiceId: string, offline: boolean): Promise<{
    audio_frames: Uint8Array[];
    duration_ms: number;
    first_frame_latency_ms: number;
  }>;
}

export interface IConsentValidator {
  isValid(consentRecordId: string, tenantId: string, principalId: string, sensor: string): Promise<boolean>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface VoiceServiceDeps {
  readonly sttAdapter: ISTTAdapter;
  readonly ttsAdapter: ITTSAdapter;
  readonly consentValidator: IConsentValidator;
}

export class VoiceService {
  private readonly sttAdapter: ISTTAdapter;
  private readonly ttsAdapter: ITTSAdapter;
  private readonly consentValidator: IConsentValidator;

  /** Default voice ID for synthesis */
  private static readonly DEFAULT_VOICE = 'may-voice-en-v1';

  constructor(deps: VoiceServiceDeps) {
    this.sttAdapter = deps.sttAdapter;
    this.ttsAdapter = deps.ttsAdapter;
    this.consentValidator = deps.consentValidator;
  }

  /**
   * Transcribe audio frames to text.
   *
   * Only processes frames with valid consent record.
   * In Offline_Mode, uses only tenant-boundary models.
   *
   * @see Requirement 1.3 — TranscribeStream STT
   * @see Requirement 1.5 — language identification and confidence
   * @see Requirement 1.9 — Offline_Mode with tenant-boundary models
   */
  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    const { tenant_id, principal_id, consent_record_id, audio_frames, offline_mode = false } = request;

    const hasConsent = await this.consentValidator.isValid(
      consent_record_id, tenant_id, principal_id, 'microphone',
    );
    if (!hasConsent) {
      throw new Error('CONSENT_REQUIRED: No valid consent record for microphone sensor');
    }

    const result = await this.sttAdapter.transcribe(audio_frames, offline_mode);

    return {
      transcript: result.transcript,
      language_code: result.language_code,
      language_confidence: result.language_confidence,
      word_error_rate_estimate: result.wer_estimate,
      is_final: true,
      latency_ms: result.latency_ms,
    };
  }

  /**
   * Synthesize text to speech audio.
   *
   * @see Requirement 1.4 — TTS latency ≤1500ms at p95
   * @see Requirement 1.6 — voice personalization
   */
  async synthesize(request: SynthesizeRequest): Promise<SynthesisResult> {
    const { tenant_id, principal_id, consent_record_id, text, voice_id = VoiceService.DEFAULT_VOICE, offline_mode = false } = request;

    const hasConsent = await this.consentValidator.isValid(
      consent_record_id, tenant_id, principal_id, 'speakers',
    );
    if (!hasConsent) {
      throw new Error('CONSENT_REQUIRED: No valid consent record for audio output');
    }

    const result = await this.ttsAdapter.synthesize(text, voice_id, offline_mode);

    return {
      audio_frames: result.audio_frames,
      duration_ms: result.duration_ms,
      first_frame_latency_ms: result.first_frame_latency_ms,
      voice_id,
    };
  }
}
