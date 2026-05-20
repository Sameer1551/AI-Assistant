/**
 * @module hud-client-service
 * HUD_Client_Service: Status visualization, confirmation gates, and cognitive-adaptive layout.
 *
 * @see Requirements 10.1–10.9
 */

import type { CognitiveState, GoalSummary } from '@may/types';
import type { IHudIdGenerator, IHudClock, IEdgeAgentClient } from './interfaces/index.js';

export type HudStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting' | 'paused' | 'offline' | 'error';

export interface HudActionConfirmation {
  readonly actionId: string;
  readonly description: string;
  readonly workflowName: string;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly confirmationChallenge?: string;
  confirmed: boolean;
}

export class HudClientService {
  private readonly edgeAgentClient: IEdgeAgentClient;

  private status: HudStatus = 'idle';
  private offlineMode: boolean = false;
  private consentGranted: boolean = false;
  private currentCognitiveState: CognitiveState | null = null;
  private pendingConfirmations: HudActionConfirmation[] = [];
  
  // Layout states
  private layoutComplexity: 'normal' | 'compact' = 'normal';
  private suppressSuggestions: boolean = false;
  private suggestions: string[] = [];
  private goalSummary: GoalSummary | null = null;

  constructor(deps: {
    readonly idGenerator: IHudIdGenerator;
    readonly clock: IHudClock;
    readonly edgeAgentClient: IEdgeAgentClient;
  }) {
    this.edgeAgentClient = deps.edgeAgentClient;
  }

  getStatus(): HudStatus {
    return this.status;
  }

  updateStatus(status: HudStatus): void {
    this.status = status;
  }

  setOfflineMode(offline: boolean): void {
    this.offlineMode = offline;
  }

  isOfflineMode(): boolean {
    return this.offlineMode;
  }

  setConsentGranted(granted: boolean): void {
    this.consentGranted = granted;
  }

  isConsentGranted(): boolean {
    return this.consentGranted;
  }

  getLayoutComplexity(): 'normal' | 'compact' {
    return this.layoutComplexity;
  }

  isSuppressSuggestions(): boolean {
    return this.suppressSuggestions;
  }

  getSuggestions(): string[] {
    return this.suggestions;
  }

  getPendingConfirmations(): HudActionConfirmation[] {
    return this.pendingConfirmations;
  }

  getCurrentCognitiveState(): CognitiveState | null {
    return this.currentCognitiveState;
  }

  /**
   * Pause the Edge Agent within 1s.
   *
   * @see Requirement 10.2
   */
  async pause(): Promise<void> {
    await this.edgeAgentClient.pauseAgent();
    this.status = 'paused';
  }

  /**
   * Resume the Edge Agent.
   *
   * @see Requirement 10.2
   */
  async resume(): Promise<void> {
    await this.edgeAgentClient.resumeAgent();
    this.status = 'idle';
  }

  /**
   * Trigger the Kill Switch.
   *
   * @see Requirement 10.3
   */
  async triggerKillSwitch(): Promise<void> {
    await this.edgeAgentClient.triggerKillSwitch();
    this.status = 'offline';
    this.consentGranted = false;
  }

  /**
   * Queue action requiring confirmation.
   *
   * @see Requirement 10.5
   */
  queueConfirmation(action: Omit<HudActionConfirmation, 'confirmed'>): void {
    this.pendingConfirmations.push({
      ...action,
      confirmed: false,
    });
  }

  confirmAction(actionId: string): void {
    const confirmation = this.pendingConfirmations.find(c => c.actionId === actionId);
    if (confirmation) {
      confirmation.confirmed = true;
    }
  }

  /**
   * Adapt HUD layout based on current user CognitiveState.
   *
   * @see Requirement 10.6, 10.7
   */
  adaptLayout(state: CognitiveState): void {
    this.currentCognitiveState = state;

    // 1. Focus depth >0.75 -> compact layout (Requirement 10.6)
    if (state.focus_depth > 0.75) {
      this.layoutComplexity = 'compact';
    } else {
      this.layoutComplexity = 'normal';
    }

    // 2. Interruption tolerance <0.25 -> suppress suggestion chips (Requirement 10.6)
    if (state.interruption_tolerance < 0.25) {
      this.suppressSuggestions = true;
      this.suggestions = [];
    } else {
      this.suppressSuggestions = false;
      // Show contextual suggestion chips when interruption tolerance >0.5
      if (state.interruption_tolerance > 0.5) {
        this.suggestions = ['Focus Mode', 'Take a Break', 'Review Schedule'];
      } else {
        this.suggestions = [];
      }
    }
  }

  /**
   * Dismiss suggestions with a single action.
   *
   * @see Requirement 10.7
   */
  dismissSuggestions(): void {
    this.suggestions = [];
  }

  setGoalSummary(summary: GoalSummary): void {
    this.goalSummary = summary;
  }

  getGoalSummary(): GoalSummary | null {
    return this.goalSummary;
  }
}
