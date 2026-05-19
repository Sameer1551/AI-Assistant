/**
 * Rollback and dry-run data models for the Control_Service.
 *
 * The Control_Service generates dry-run previews describing predicted effects
 * of actions and records rollback descriptors containing sufficient information
 * to reverse actions.
 *
 * @module rollback
 */

/**
 * Reversibility classification for an action.
 */
export type Reversibility = 'fully_reversible' | 'partially_reversible' | 'irreversible';

/**
 * Type of change a predicted effect describes.
 */
export type ChangeType = 'create' | 'modify' | 'delete' | 'move';

/**
 * A descriptor containing sufficient information to reverse an executed action.
 * Retained per tenant configuration (default 24 hours).
 */
export interface RollbackDescriptor {
  /** Unique identifier for this descriptor */
  readonly descriptor_id: string;
  /** The action this rollback applies to */
  readonly action_id: string;
  /** Tenant that owns this rollback descriptor */
  readonly tenant_id: string;
  /** Principal who executed the original action */
  readonly principal_id: string;
  /** Type of the original action (e.g., "file.delete", "browser.navigate") */
  readonly action_type: string;
  /** Ordered steps required to reverse the action */
  readonly rollback_steps: RollbackStep[];
  /** ISO 8601 timestamp of when the descriptor was created */
  readonly created_at: string;
  /** ISO 8601 timestamp of when this descriptor expires */
  readonly expires_at: string;
  /** Whether the rollback has been executed */
  readonly executed: boolean;
}

/**
 * A single step in a rollback sequence.
 */
export interface RollbackStep {
  /** Unique identifier for this step */
  readonly step_id: string;
  /** Human-readable description of what this step reverses */
  readonly description: string;
  /** The action request that performs the reversal */
  readonly reverse_action: RollbackActionReference;
  /** Execution order (lower numbers execute first) */
  readonly order: number;
}

/**
 * A reference to an action request used in rollback steps.
 * Kept as a separate interface to avoid circular dependency with the core action model.
 */
export interface RollbackActionReference {
  /** Action type identifier */
  readonly action_type: string;
  /** Parameters for the reverse action */
  readonly parameters: Record<string, unknown>;
  /** Timeout for the reverse action in seconds */
  readonly timeout_seconds: number;
}

/**
 * Result of a dry-run preview describing predicted effects of an action before confirmation.
 */
export interface DryRunResult {
  /** The action being previewed */
  readonly action_id: string;
  /** List of predicted effects */
  readonly predicted_effects: PredictedEffect[];
  /** Human-readable risk assessment */
  readonly risk_assessment: string;
  /** How reversible the action is */
  readonly reversibility: Reversibility;
  /** Resources that would be affected */
  readonly affected_resources: readonly string[];
  /** ISO 8601 timestamp of when the preview was generated */
  readonly timestamp: string;
}

/**
 * A single predicted effect of an action on a resource.
 */
export interface PredictedEffect {
  /** Human-readable description of the effect */
  readonly description: string;
  /** The resource that would be affected */
  readonly resource: string;
  /** Type of change that would occur */
  readonly change_type: ChangeType;
  /** Confidence in this prediction [0.0, 1.0] */
  readonly confidence: number;
}
