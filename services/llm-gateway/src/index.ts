/**
 * @may/llm-gateway - LlmGateway Service
 *
 * Entry point for the LlmGateway service.
 * Sole broker for all model invocations with prompt-injection defense,
 * output filtering, model routing, rate limiting, and budget enforcement.
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
  IOutputFilter,
  FilteredContentCategory,
  OutputRedaction,
  TenantOutputPolicy,
  DenyRule,
  OutputFilterResult,
} from './interfaces/index.js';

export { PromptInjectionDefense } from './prompt-injection-defense.js';
export { OutputFilter } from './output-filter.js';
