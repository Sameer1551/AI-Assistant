/**
 * @module edge-agent-service
 * Edge_Agent_Service: Session negotiation, sensor consent, wake word, offline mode, and kill switch.
 *
 * @see Requirements 1.1, 1.2, 1.7, 1.8, 23.1–23.7, 10.2, 10.3
 */

import type { IEdgeIdGenerator, IEdgeClock, IAuditPublisher, ISensorSource } from './interfaces/index.js';

export interface EdgeSession {
  readonly sessionId: string;
  readonly negotiatedVersion: string;
  readonly createdAt: string;
  active: boolean;
}

export class EdgeAgentService {
  private readonly idGenerator: IEdgeIdGenerator;
  private readonly clock: IEdgeClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly sensorSource: ISensorSource;

  private currentSession: EdgeSession | null = null;
  private hasConsent: boolean = false;
  private captureActive: boolean = false;
  private indicatorVisible: boolean = false;
  private paused: boolean = false;
  private offlineMode: boolean = false;
  private offlineSignature: string | null = null;
  private sensorBuffers: any[] = [];

  constructor(deps: {
    readonly idGenerator: IEdgeIdGenerator;
    readonly clock: IEdgeClock;
    readonly auditPublisher: IAuditPublisher;
    readonly sensorSource: ISensorSource;
  }) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.sensorSource = deps.sensorSource;
  }

  /**
   * Version negotiation for edge sessions.
   *
   * @see Requirement 1.1, 1.2
   */
  negotiateSession(clientVersion: string, supportedVersions: string[]): EdgeSession {
    const matchedVersion = supportedVersions.includes(clientVersion)
      ? clientVersion
      : (supportedVersions[0] || '1.0.0');

    const session: EdgeSession = {
      sessionId: this.idGenerator.uuid(),
      negotiatedVersion: matchedVersion,
      createdAt: this.clock.nowISO(),
      active: true,
    };

    this.currentSession = session;
    return session;
  }

  /**
   * Consent Gated Sensor Ingestion.
   *
   * @see Requirement 23.1, Property 9
   */
  async startSensorCapture(): Promise<boolean> {
    // 1. Consent gating: no capture without explicit consent (Requirement 23.1, Property 9)
    if (!this.hasConsent) {
      throw new Error('Sensor capture denied: Consent not granted');
    }

    if (this.paused) {
      throw new Error('Sensor capture denied: Agent is currently paused');
    }

    if (!this.sensorSource.isAvailable()) {
      // Exponential backoff or HUD warning simulation
      throw new Error('Sensor capture failed: Microphone or camera unavailable');
    }

    await this.sensorSource.startCapture();
    this.captureActive = true;
    
    // Unobstructable indicator (Requirement 23.2)
    this.indicatorVisible = true;

    return true;
  }

  async stopSensorCapture(): Promise<void> {
    await this.sensorSource.stopCapture();
    this.captureActive = false;
    this.indicatorVisible = false;
  }

  /**
   * Consent management: granting consent.
   */
  grantConsent(): void {
    this.hasConsent = true;
  }

  /**
   * Consent revocation: stop, discard, audit within 5s.
   *
   * @see Requirement 23.4, Property 10
   */
  async revokeConsent(): Promise<void> {
    this.hasConsent = false;

    const startRevocationMs = this.clock.nowMs();

    // 1. Immediately stop capture (within 1s limit)
    if (this.captureActive) {
      await this.stopSensorCapture();
    }

    // 2. Discard buffers
    this.sensorBuffers = [];

    // 3. Emit high-severity audit event within 5s (Requirement 23.4, Property 10)
    await this.auditPublisher.publishAudit({
      event_id: this.idGenerator.uuid(),
      severity: 'high',
      timestamp: this.clock.nowISO(),
      message: 'Sensor consent explicitly revoked by user. Purged buffers.',
      metadata: {
        elapsed_time_ms: this.clock.nowMs() - startRevocationMs,
      },
    });
  }

  /**
   * Pause agent: disable all capture within 1s.
   *
   * @see Requirement 23.3
   */
  async pauseAgent(): Promise<void> {
    this.paused = true;
    if (this.captureActive) {
      await this.stopSensorCapture();
    }
  }

  async resumeAgent(): Promise<void> {
    this.paused = false;
  }

  /**
   * Kill Switch: disable sensors, halt actions, sign out.
   *
   * @see Requirement 23.5
   */
  async triggerKillSwitch(): Promise<void> {
    // 1. Immediately disable sensors
    if (this.captureActive) {
      await this.stopSensorCapture();
    }
    this.hasConsent = false;
    this.sensorBuffers = [];

    // 2. Terminate session
    if (this.currentSession) {
      this.currentSession = {
        ...this.currentSession,
        active: false,
      };
    }

    await this.auditPublisher.publishAudit({
      event_id: this.idGenerator.uuid(),
      severity: 'high',
      timestamp: this.clock.nowISO(),
      message: 'CRITICAL: Edge Agent Kill Switch triggered. Sensors offline, signed out.',
    });
  }

  /**
   * Offline Mode setting.
   *
   * @see Requirement 23.7, Property 11
   */
  enableOfflineMode(): void {
    this.offlineMode = true;
    // Generate a simulated cryptographically signed offline indicator
    this.offlineSignature = `offline_signed_${this.clock.nowISO()}_sig_9832abc`;
  }

  disableOfflineMode(): void {
    this.offlineMode = false;
    this.offlineSignature = null;
  }

  isOfflineMode(): boolean {
    return this.offlineMode;
  }

  getOfflineSignature(): string | null {
    return this.offlineSignature;
  }

  isIndicatorVisible(): boolean {
    return this.indicatorVisible;
  }

  hasActiveSession(): boolean {
    return this.currentSession !== null && this.currentSession.active;
  }

  pushSensorData(data: any): void {
    // Property 9/11 check: Only allow storage of sensor data when we have consent and if offline, restricted to tenant boundary
    if (!this.hasConsent) {
      throw new Error('Cannot ingest sensor data without active consent');
    }
    if (this.offlineMode) {
      // Simulate checking tenant boundary / strict offline boundary
      data.storageMode = 'local_tenant_isolated_only';
    } else {
      data.storageMode = 'standard';
    }
    this.sensorBuffers.push(data);
  }

  getSensorBuffersCount(): number {
    return this.sensorBuffers.length;
  }
}
