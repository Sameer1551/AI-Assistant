/**
 * @module slo-monitor
 * SLOMonitor — tracks error budgets and emits alerts at thresholds.
 *
 * Computes SLO status from recorded observations, tracks error budget consumption,
 * and emits alerts when budget drops below 25% or when the SLO is breached.
 *
 * @see Requirement 18.1 - SLO definitions per service
 * @see Requirement 18.3 - Compute and publish every ≤5 min
 * @see Requirement 18.4 - Budget-warning alert at 25% remaining
 * @see Requirement 18.5 - High-severity alert on SLO breach
 */

import type {
  ISLOMonitor,
  SLODefinition,
  SLOStatus,
  TelemetryAlert,
} from './interfaces/index.js';

/**
 * Internal state for tracking an SLO's observations.
 */
interface SLOState {
  readonly definition: SLODefinition;
  /** Total observations in the current window */
  totalObservations: number;
  /** Successful observations in the current window */
  successObservations: number;
  /** Window start timestamp */
  windowStart: number;
  /** Whether a budget-warning alert has been emitted for this window */
  budgetWarningEmitted: boolean;
  /** Whether a breach alert has been emitted for this window */
  breachAlertEmitted: boolean;
}

/** Budget warning threshold: emit alert when remaining budget drops below 25%. */
const BUDGET_WARNING_THRESHOLD = 0.25;

/**
 * SLOMonitor implementation.
 *
 * Tracks per-SLO observations and computes error budget status.
 * Emits alerts when error budget is running low or exhausted.
 */
export class SLOMonitor implements ISLOMonitor {
  private readonly sloStates = new Map<string, SLOState>();
  private readonly alerts: TelemetryAlert[] = [];
  private alertCounter = 0;

  registerSLO(definition: SLODefinition): void {
    this.sloStates.set(definition.slo_id, {
      definition,
      totalObservations: 0,
      successObservations: 0,
      windowStart: Date.now(),
      budgetWarningEmitted: false,
      breachAlertEmitted: false,
    });
  }

  recordObservation(sloId: string, success: boolean): void {
    const state = this.sloStates.get(sloId);
    if (!state) return;

    state.totalObservations++;
    if (success) {
      state.successObservations++;
    }
  }

  computeStatus(sloId: string): SLOStatus {
    const state = this.sloStates.get(sloId);
    if (!state) {
      throw new Error(`SLO not registered: ${sloId}`);
    }

    const { definition } = state;
    const now = Date.now();

    // Compute current SLI value
    const currentSli = state.totalObservations > 0
      ? state.successObservations / state.totalObservations
      : 1.0; // No observations = assume healthy

    // Compute error budget
    // Error budget = 1 - target (e.g., for 99.9% availability, budget is 0.1%)
    const errorBudgetTotal = 1 - definition.target;

    // Error budget consumed = 1 - current_sli (fraction of requests that failed)
    const errorBudgetConsumed = state.totalObservations > 0
      ? (state.totalObservations - state.successObservations) / state.totalObservations
      : 0;

    // Remaining budget as fraction of total budget
    const errorBudgetRemaining = errorBudgetTotal > 0
      ? Math.max(0, (errorBudgetTotal - errorBudgetConsumed) / errorBudgetTotal)
      : (errorBudgetConsumed > 0 ? 0 : 1);

    const isMet = currentSli >= definition.target;

    // Check alert conditions
    this.checkAlerts(state, errorBudgetRemaining, isMet);

    return {
      definition,
      current_sli: currentSli,
      is_met: isMet,
      error_budget_remaining: errorBudgetRemaining,
      error_budget_total: errorBudgetTotal,
      error_budget_consumed: errorBudgetConsumed,
      computed_at: new Date(now).toISOString(),
    };
  }

  getAlerts(): readonly TelemetryAlert[] {
    return [...this.alerts];
  }

  clearAlerts(): void {
    this.alerts.length = 0;
  }

  /**
   * Checks whether alert conditions are met and emits alerts.
   */
  private checkAlerts(state: SLOState, budgetRemaining: number, isMet: boolean): void {
    const { definition } = state;

    // Emit budget-warning alert at 25% remaining
    if (budgetRemaining <= BUDGET_WARNING_THRESHOLD && budgetRemaining > 0 && !state.budgetWarningEmitted) {
      this.emitAlert({
        severity: 'warning',
        type: 'budget_warning',
        slo_id: definition.slo_id,
        service_name: definition.service_name,
        message: `Error budget for SLO "${definition.name}" is at ${(budgetRemaining * 100).toFixed(1)}% remaining (threshold: 25%)`,
        error_budget_remaining: budgetRemaining,
      });
      state.budgetWarningEmitted = true;
    }

    // Emit high-severity alert on SLO breach
    if (!isMet && !state.breachAlertEmitted) {
      this.emitAlert({
        severity: 'high',
        type: 'slo_breach',
        slo_id: definition.slo_id,
        service_name: definition.service_name,
        message: `SLO "${definition.name}" has been breached. Current SLI is below target ${definition.target}`,
        error_budget_remaining: budgetRemaining,
      });
      state.breachAlertEmitted = true;
    }
  }

  /**
   * Emits an alert and adds it to the alerts list.
   */
  private emitAlert(params: Omit<TelemetryAlert, 'alert_id' | 'emitted_at'>): void {
    this.alertCounter++;
    const alert: TelemetryAlert = {
      ...params,
      alert_id: `alert-${this.alertCounter}-${Date.now()}`,
      emitted_at: new Date().toISOString(),
    };
    this.alerts.push(alert);
  }
}
