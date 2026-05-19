/**
 * @module confirmation
 * Confirmation_Challenge model — server-issued nonce-based confirmation
 * for HIGH and CRITICAL risk actions.
 *
 * The challenge binds a single-use nonce to a specific action request and session,
 * preventing replay attacks and ensuring the user explicitly authorizes the action.
 */

import type {
  ChallengeId,
  ActionId,
  SessionId,
  ISOTimestamp,
} from './branded.js';

/**
 * Input method used to respond to a confirmation challenge.
 */
export type ChallengeInputMethod = 'voice' | 'hud_input';

/**
 * A server-issued confirmation challenge for HIGH/CRITICAL risk actions.
 *
 * @remarks
 * - The nonce is single-use: once consumed, it cannot authorize another action.
 * - expires_at is at most 60 seconds from issuance.
 * - The challenge is bound to a specific action_request_id and session_id.
 * - Validation requires all four conditions: nonce match, not expired,
 *   same session, and not previously consumed.
 */
export interface ConfirmationChallenge {
  /** UUID — unique identifier for this challenge instance. */
  readonly challenge_id: ChallengeId;

  /** Server-generated, cryptographically random, single-use nonce. */
  readonly nonce: string;

  /** UUID of the action request this challenge authorizes. */
  readonly action_request_id: ActionId;

  /** UUID of the session in which this challenge was issued. */
  readonly session_id: SessionId;

  /**
   * ISO 8601 timestamp when this challenge expires.
   * Maximum 60 seconds from issuance.
   */
  readonly expires_at: ISOTimestamp;

  /** Human-readable description of the action being authorized. */
  readonly action_description: string;

  /** Whether this nonce has been consumed. Single-use enforcement. */
  readonly consumed: boolean;
}

/**
 * The user's response to a confirmation challenge.
 *
 * @remarks
 * - The nonce must exactly match the issued nonce.
 * - The session_id must match the challenge's session_id.
 * - The response must arrive before the challenge's expires_at.
 */
export interface ChallengeResponse {
  /** UUID of the challenge being responded to. */
  readonly challenge_id: ChallengeId;

  /** The nonce value — must match the issued nonce exactly. */
  readonly nonce: string;

  /** Session in which the response is submitted — must match challenge session. */
  readonly session_id: SessionId;

  /** The input method used to provide the confirmation. */
  readonly input_method: ChallengeInputMethod;
}
