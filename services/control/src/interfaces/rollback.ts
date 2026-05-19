/**
 * Rollback tracking interfaces.
 *
 * The rollback tracking system records state before action execution
 * so that actions can be rolled back. Maintains a rollback log with
 * before/after state snapshots for MEDIUM+ risk actions that complete
 * with SUCCESS outcome.
 */

import type { ActionRequest, ActionResponse } from '@may/types';
import type { RollbackDescriptor, RollbackStep } from '@may/types';

/**
 * Configuration for rollback retention.
 */
export interface RollbackConfig {
  /** Retention period in hours (default 24) */
  readonly retention_hours: number;
}

/**
 * Store for persisting and retrieving rollback descriptors.
 */
export interface IRollbackStore {
  /**
   * Save a rollback descriptor.
   * @param descriptor - The descriptor to persist
   */
  save(descriptor: RollbackDescriptor): Promise<void>;

  /**
   * Retrieve a rollback descriptor by action ID.
   * @param actionId - The action ID to look up
   * @param tenantId - The tenant ID for isolation
   * @returns The descriptor, or undefined if not found or expired
   */
  getByActionId(actionId: string, tenantId: string): Promise<RollbackDescriptor | undefined>;

  /**
   * Retrieve a rollback descriptor by descriptor ID.
   * @param descriptorId - The descriptor ID to look up
   * @param tenantId - The tenant ID for isolation
   * @returns The descriptor, or undefined if not found or expired
   */
  getByDescriptorId(descriptorId: string, tenantId: string): Promise<RollbackDescriptor | undefined>;

  /**
   * Mark a descriptor as executed (rollback was performed).
   * @param descriptorId - The descriptor to mark
   * @param tenantId - The tenant ID for isolation
   */
  markExecuted(descriptorId: string, tenantId: string): Promise<void>;

  /**
   * Remove expired descriptors.
   * @returns Number of descriptors removed
   */
  removeExpired(): Promise<number>;
}

/**
 * Strategy interface for generating rollback steps for a specific action type.
 */
export interface IRollbackStepGenerator {
  /** The action type this generator handles */
  readonly action_type: string;

  /**
   * Generate rollback steps for a completed action.
   * @param request - The original action request
   * @param response - The action response (SUCCESS outcome)
   * @returns Ordered rollback steps to reverse the action
   */
  generateSteps(request: ActionRequest, response: ActionResponse): Promise<RollbackStep[]>;
}

/**
 * Service responsible for tracking rollback information.
 */
export interface IRollbackTracker {
  /**
   * Record a rollback descriptor for a successfully completed action.
   * Only records for MEDIUM+ risk level actions.
   *
   * @param request - The original action request
   * @param response - The action response (must have SUCCESS outcome)
   * @returns The created rollback descriptor, or undefined if not applicable
   */
  recordRollback(request: ActionRequest, response: ActionResponse): Promise<RollbackDescriptor | undefined>;

  /**
   * Retrieve the rollback descriptor for a given action.
   * @param actionId - The action ID
   * @param tenantId - The tenant ID for isolation
   * @returns The rollback descriptor, or undefined if not found/expired
   */
  getRollbackDescriptor(actionId: string, tenantId: string): Promise<RollbackDescriptor | undefined>;

  /**
   * Execute a rollback for a previously completed action.
   * @param descriptorId - The rollback descriptor ID
   * @param tenantId - The tenant ID for isolation
   * @returns The executed rollback descriptor
   * @throws If descriptor not found, expired, or already executed
   */
  executeRollback(descriptorId: string, tenantId: string): Promise<RollbackDescriptor>;

  /**
   * Register a rollback step generator for a specific action type.
   * @param generator - The generator to register
   */
  registerGenerator(generator: IRollbackStepGenerator): void;

  /**
   * Clean up expired rollback descriptors.
   * @returns Number of descriptors removed
   */
  cleanupExpired(): Promise<number>;
}
