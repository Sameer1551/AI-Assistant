/**
 * LlmGateway service interfaces.
 * Service contracts and dependency injection interfaces.
 *
 * @see Requirement 4 — Multi-Model Reasoning Through the LLM_Gateway
 * @see Requirement 20 — Threat Model and Security Hardening
 */

export type {
  IPromptInjectionDefense,
  InjectionSeverity,
  InjectionCategory,
  InjectionDetectionResult,
  SanitizationResult,
} from './prompt-injection-defense.js';

export type {
  IOutputFilter,
  FilteredContentCategory,
  OutputRedaction,
  TenantOutputPolicy,
  DenyRule,
  OutputFilterResult,
} from './output-filter.js';
