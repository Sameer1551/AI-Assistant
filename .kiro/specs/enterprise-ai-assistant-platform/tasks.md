# Implementation Plan: Enterprise AI Assistant Platform ("May")

## Overview

This implementation plan breaks down the Enterprise AI Assistant Platform into incremental coding tasks organized by service domain. Each task builds on previous steps, starting with foundational infrastructure (shared types, identity, audit) and progressing through core services, cognitive intelligence, advanced memory, planning/reasoning, extensibility, and infrastructure management. TypeScript is used throughout, with fast-check for property-based testing.

## Tasks

- [ ] 1. Set up project structure, shared types, and core interfaces
  - [x] 1.1 Create monorepo structure with service directories and shared packages
    - Initialize TypeScript monorepo (e.g., Nx or Turborepo)
    - Create directories for each service: identity, llm-gateway, voice, vision, control, memory, workflow, code-sandbox, emotion, habit, audit, telemetry, secrets, governance, eval, cost, context-intelligence, cognitive-state, personality, proactive-intelligence, intent-graph, knowledge-grounding, pokg, goal-engine, simulation, reflection, planning, plugin, self-improvement, fine-tuning, research, resource-governor, watchdog, compute-fabric, environment-model, edge-agent, hud-client
    - Create shared packages: types, utils, testing
    - Set up tsconfig, eslint, prettier, and fast-check
    - _Requirements: 14.1, 14.2, 15.1_

  - [-] 1.2 Define core shared data models and interfaces
    - Implement RequestContext, ActionRequest, ActionResponse, ActionError interfaces
    - Implement ConfirmationChallenge, ChallengeResponse interfaces
    - Implement PlatformError interface and error taxonomy enum
    - Implement TenantConfig interface with all configuration fields
    - _Requirements: 2.1, 13.1, 14.2, 24.1_

  - [-] 1.3 Define memory, audit, and governance data models
    - Implement MemoryRecord, MemoryLayer, Provenance interfaces
    - Implement AuditEvent interface with chain hash and sequence number
    - Implement DataClassification, RedactionResult, PIIDetection, DSARRequest interfaces
    - Implement UsageEvent, BudgetConfig interfaces
    - _Requirements: 5.1, 21.2, 25.1, 26.1, 34.1_

  - [-] 1.4 Define cognitive intelligence and advanced memory data models
    - Implement ContextPacket, ContextField interfaces
    - Implement CognitiveState, CognitiveDirective interfaces
    - Implement StyleProfile, CoreCharacterDefinition, DriftBenchmarkResult interfaces
    - Implement ProactiveSignal, InterruptBudgetStatus, DeliveryDecision interfaces
    - Implement IntentNode, IntentEdge interfaces with type constraints
    - Implement FreshnessClassification, GroundedContext, GroundedClaim interfaces
    - _Requirements: 36.1, 37.1, 38.1, 39.1, 40.1, 41.1_

  - [-] 1.5 Define planning, simulation, goal, and extensibility data models
    - Implement SimulationResult, FailureMode, ResourceDelta interfaces
    - Implement Goal, Milestone, GoalStatus, WeeklyReviewReport interfaces
    - Implement ReflectionRecord, FailurePattern interfaces
    - Implement PlanTree, PlanNode, PlanChecklist interfaces
    - Implement PluginManifest, PluginExecutionResult interfaces
    - Implement ImprovementCycle, PromptVersion, LoRAAdapter interfaces
    - Implement ThrottleLevel, ResourceStatus, ThrottleLevelTransition, ThrottleConfig interfaces
    - Implement EnvironmentState, EnvironmentChangeEvent interfaces
    - Implement ResourceInventory, GPUDevice, LoadedModel, InferenceTicket interfaces
    - Implement RollbackDescriptor, DryRunResult interfaces
    - _Requirements: 44.1, 45.2, 46.2, 47.1, 48.2, 49.2, 50.3, 52.2, 54.1, 55.1, 2.14, 2.15_

  - [-] 1.6 Define workflow and model registry data models
    - Implement WorkflowDefinition, WorkflowStep, RetryPolicy interfaces
    - Implement EmotionalState interface with valid ranges
    - Implement ModelRegistryEntry with canary and circuit breaker config
    - _Requirements: 4.2, 7.1, 8.1_

- [ ] 2. Implement Identity_Service and authorization
  - [~] 2.1 Implement token issuance and validation
    - Implement Authenticate, RefreshToken, ValidateToken RPCs
    - Enforce access token lifetime ≤60 minutes, refresh token ≤24 hours
    - Validate signature, audience, expiry, and revocation status
    - Support OIDC federation with external identity provider
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [~] 2.2 Write property tests for token lifetime and validation (Properties 34, 35)
    - **Property 34: Token Lifetime Constraints** — access token ≤60min, refresh ≤24h
    - **Property 35: Token Validation Completeness** — all checks (signature, audience, expiry, revocation) must pass
    - **Validates: Requirements 11.2, 11.3**

  - [~] 2.3 Implement RBAC/ABAC authorization engine
    - Implement Authorize RPC with role and attribute evaluation
    - Implement built-in roles: End_User, Tenant_Administrator, Platform_Operator, Security_Officer, Auditor
    - Implement custom role definitions with explicit permission grants
    - Implement default-deny policy (no explicit grant = deny)
    - Emit authorization decision audit events
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [~] 2.4 Write property tests for authorization (Properties 36, 37)
    - **Property 36: Default Deny Authorization** — deny when no explicit grant exists
    - **Property 37: Authorization Decision Audit** — every decision emits audit event with principal, resource, action, decision, policy
    - **Validates: Requirements 12.4, 12.5**

  - [~] 2.5 Implement Confirmation_Challenge issuance and validation
    - Implement IssueConfirmationChallenge with server nonce, 60s expiry, action binding
    - Implement ValidateConfirmationChallenge with nonce match, expiry check, session binding, single-use enforcement
    - Implement progressive lockout on failed validation
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6_

  - [~] 2.6 Write property tests for Confirmation_Challenge (Properties 12, 13)
    - **Property 12: Confirmation_Challenge Validation** — accept only when all 4 conditions hold (nonce match, not expired, same session, not consumed)
    - **Property 13: Confirmation_Challenge Action Binding** — challenge bound to specific action_request_id
    - **Validates: Requirements 24.4, 24.5, 24.6**

  - [~] 2.7 Implement service-to-service authentication (mTLS/SPIFFE)
    - Implement mutual TLS validation for inter-service calls
    - Reject unauthenticated service-to-service traffic
    - Implement break-glass access with dual approval, 4h time limit, and audit events
    - _Requirements: 11.5, 11.6, 12.6_

- [~] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Audit_Service with tamper-evident chain
  - [~] 4.1 Implement audit event ingestion and cryptographic chaining
    - Implement Ingest RPC with monotonically increasing sequence numbers
    - Implement SHA-256 chain hash linking each event to previous in tenant chain
    - Implement chain segment signing using Secrets_Service keys
    - Validate all required fields: timestamp, tenant_id, principal_id, source_service, event_category, severity, correlation_id, outcome
    - _Requirements: 21.1, 21.2, 21.3, 21.7_

  - [~] 4.2 Write property tests for audit chain integrity (Properties 5, 6)
    - **Property 5: Audit Event Integrity Chain** — monotonic sequence numbers, correct chain hashes, tamper detection
    - **Property 6: Audit Event Completeness** — all required fields present and non-empty
    - **Validates: Requirements 21.2, 21.3, 21.7**

  - [~] 4.3 Implement audit query and verification interface
    - Implement Query RPC with tenant-scoped filtering
    - Implement VerifyChain RPC that detects insertion, deletion, or modification
    - Implement retention enforcement (≥365 days minimum)
    - _Requirements: 21.3, 21.4_

  - [~] 4.4 Implement SIEM forwarding with durable buffering
    - Forward events to tenant-configured SIEM within 60s at p95
    - Buffer durably on forwarding failure with backoff retry
    - Emit high-severity alert if buffer age exceeds 1 hour
    - _Requirements: 21.5, 21.6_

- [ ] 5. Implement Governance_Service (PII, retention, residency)
  - [~] 5.1 Implement PII detection and redaction pipeline
    - Implement detection for: names, addresses, phone, email, government IDs, payment cards, bank accounts, IPs, geolocation, DOB, credentials
    - Implement tenant-configurable redaction policy (block/flag/redact posture)
    - Generate redaction reports with categories, counts, destination, policy version
    - Enforce precision ≥0.95 and recall ≥0.90 against Golden_Eval_Set
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5_

  - [~] 5.2 Write property tests for PII redaction (Properties 14, 15)
    - **Property 14: PII Redaction Before Boundary Crossing** — all PII categories redacted before external transmission
    - **Property 15: PII Redaction Report Generation** — every redaction produces report with categories, counts, destination, policy version
    - **Validates: Requirements 26.2, 26.3**

  - [~] 5.3 Implement data classification, retention, and residency enforcement
    - Implement tenant-configurable classification taxonomy
    - Implement retention rules per classification and per component
    - Trigger irreversible deletion/cryptographic shredding within 24h of expiry
    - Enforce Data_Residency_Region across persistence and processing
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

  - [~] 5.4 Write property test for retention policy (Property 23)
    - **Property 23: Retention Policy Application** — records exceeding retention duration are marked for deletion/shredding
    - **Validates: Requirements 5.6, 25.2**

  - [~] 5.5 Implement DSAR processing
    - Implement intake interface for access, rectification, export, erasure requests
    - Acknowledge within 72h, respond within 30 days
    - Issue erasure orders to all owning services, track per-service completion
    - Exclude records under legal hold with documented basis
    - Produce machine-readable export within 30 days
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5_

  - [~] 5.6 Write property test for DSAR erasure propagation (Property 45)
    - **Property 45: DSAR Erasure Propagation** — erasure orders issued to all owning services, tracked per service, legal hold exclusions respected
    - **Validates: Requirements 27.3, 27.4**

- [ ] 6. Implement Secrets_Service and cryptographic key lifecycle
  - [~] 6.1 Implement secret retrieval, rotation, and revocation
    - Implement GetSecret, RotateKey, RevokeSecret, Encrypt, Decrypt RPCs
    - Store all keys in external KMS/Vault (FIPS 140-2 Level 2+)
    - Rotate symmetric keys ≤90 days, asymmetric ≤365 days
    - Retain only 2 most recent key versions
    - Propagate revocation within 5 minutes
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

- [ ] 7. Implement Telemetry_Service and observability
  - [~] 7.1 Implement OpenTelemetry signal ingestion and SLO monitoring
    - Implement IngestMetrics, IngestTraces, IngestLogs RPCs
    - Implement correlation_id propagation across all services
    - Compute golden signals per service (rate, error rate, latency p50/p95/p99, saturation)
    - Implement SLO computation and error budget tracking (publish every ≤5 min)
    - Emit budget-warning alert at 25% remaining, high-severity on breach
    - Implement PII redaction in telemetry pipeline
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 18.1, 18.2, 18.3, 18.4, 18.5_

  - [~] 7.2 Write property tests for telemetry (Properties 38, 39)
    - **Property 38: Correlation Identifier Propagation** — correlation_id appears in every log, trace, and audit event for a request
    - **Property 39: Telemetry PII Exclusion** — prohibited PII categories redacted before emission
    - **Validates: Requirements 17.3, 17.5**

- [~] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement LLM_Gateway with model routing and safety
  - [~] 9.1 Implement model registry and provider abstraction
    - Implement ModelRegistryEntry CRUD with versioning
    - Implement provider abstraction layer decoupling model selection from provider APIs
    - Support dual-model architecture (local + cloud)
    - _Requirements: 4.2, 4.12, 4.13_

  - [~] 9.2 Implement multi-factor model routing
    - Implement routing based on: task complexity, budget remaining, privacy classification, latency requirement, provider health
    - Enforce tenant budget mode, residency policy, and Offline_Mode constraints
    - Monitor provider health with configurable intervals, exclude unhealthy providers
    - _Requirements: 4.3, 4.4, 4.14, 4.15_

  - [~] 9.3 Write property tests for model routing (Properties 16, 17)
    - **Property 16: Model Selection Policy Compliance** — selected model satisfies all tenant constraints (budget, residency, privacy, task type, complexity)
    - **Property 17: Model Fallback Chain** — on failure/timeout/policy violation, retry next eligible model up to max retries
    - **Validates: Requirements 4.3, 4.5**

  - [~] 9.4 Implement prompt-injection defense and output filtering
    - Implement input sanitization, system-prompt isolation, injection pattern detection
    - Implement output filtering: redact secrets, prohibited PII, executable instructions, deny-rule matches
    - _Requirements: 4.6, 4.7, 20.3, 20.4_

  - [~] 9.5 Write property test for prompt-injection defense (Property 46)
    - **Property 46: Prompt-Injection Defense** — known injection patterns detected and sanitized before reaching model
    - **Validates: Requirements 4.6**

  - [~] 9.6 Implement rate limiting, budget enforcement, and circuit breaking
    - Implement per-tenant and per-principal rate limits with Retry-After
    - Implement budget enforcement (reject with BUDGET_EXCEEDED when exceeded)
    - Implement circuit breaker per model with configurable threshold, window, cooldown
    - Emit telemetry event for every invocation
    - _Requirements: 4.8, 4.9, 4.10, 4.11_

  - [~] 9.7 Write property tests for rate limiting, budget, and circuit breaker (Properties 18, 19, 20)
    - **Property 18: Budget Enforcement** — reject with BUDGET_EXCEEDED when tenant budget exceeded
    - **Property 19: Rate Limiting** — reject with RATE_LIMITED and Retry-After when limits exceeded
    - **Property 20: Circuit Breaker Activation** — open circuit when error rate exceeds threshold in rolling window
    - **Validates: Requirements 4.8, 4.9, 4.10**

  - [~] 9.8 Implement canary deployment for models and prompts
    - Route initial canary fraction to new version
    - Progress traffic share per schedule when health metrics within tolerances
    - Auto-revert on health metric breach with high-severity alert
    - Retain at least 2 most recent production-eligible versions
    - _Requirements: 30.1, 30.2, 30.3, 30.4_

  - [~] 9.9 Write property test for canary deployment (Property 40)
    - **Property 40: Canary Deployment Progression** — initial canary fraction, progress only when healthy, auto-revert on breach
    - **Validates: Requirements 30.1, 30.2, 30.3**

- [ ] 10. Implement Control_Service with risk-level enforcement
  - [~] 10.1 Implement action execution with risk-level confirmation logic
    - Accept ActionRequest with Risk_Level validation
    - Execute SAFE/LOW without confirmation
    - Require session-level confirmation for MEDIUM (120s timeout)
    - Require Confirmation_Challenge for HIGH/CRITICAL
    - Reject invalid/missing Risk_Level with validation error
    - Reject unauthorized actions with DENIED
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.10, 2.11_

  - [~] 10.2 Write property tests for risk-level logic (Properties 1, 2)
    - **Property 1: Risk-Level Determines Confirmation Requirements** — correct confirmation behavior per risk level
    - **Property 2: Invalid Action Requests Are Rejected** — missing/invalid Risk_Level rejected with validation error and DENIED audit
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.10, 2.11**

  - [~] 10.3 Implement idempotency, timeout, and audit emission
    - Implement idempotency keys with 24h deduplication window
    - Implement per-action timeout (1-600s, default 60s) with TIMEOUT outcome
    - Emit audit event within 1s of completion for all outcomes
    - _Requirements: 2.6, 2.7, 2.8_

  - [~] 10.4 Write property tests for idempotency and timeout (Properties 3, 4)
    - **Property 3: Action Idempotency** — same idempotency key within 24h returns previous outcome without re-execution
    - **Property 4: Action Timeout Enforcement** — actions exceeding timeout terminated with TIMEOUT outcome and audit event
    - **Validates: Requirements 2.7, 2.8**

  - [~] 10.5 Implement dry-run preview, rollback tracking, and self-healing selectors
    - Generate dry-run preview for MEDIUM+ actions before confirmation
    - Record rollback descriptor for MEDIUM+ SUCCESS actions (retained per tenant config, default 24h)
    - Implement ExecuteRollback RPC
    - Implement self-healing browser selector with fallback hierarchy (accessibility label, text content, visual similarity, DOM structure)
    - Implement OS abstraction layer for Windows, macOS, Linux
    - _Requirements: 2.9, 2.12, 2.13, 2.14, 2.15_

  - [~] 10.6 Write property tests for dry-run, rollback, and self-healing (Properties 101, 102, 103)
    - **Property 101: Dry-Run Preview for MEDIUM+ Actions** — preview generated before confirmation
    - **Property 102: Rollback Descriptor Retention** — descriptor recorded for MEDIUM+ SUCCESS actions
    - **Property 103: Self-Healing Browser Selector** — fallback hierarchy attempted, migration logged
    - **Validates: Requirements 2.12, 2.14, 2.15**

- [~] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Implement Memory_Service with governance integration
  - [~] 12.1 Implement five-layer memory with tenant/principal isolation
    - Implement Write, Query, Delete, ApplyRetention RPCs
    - Implement Working, Episodic, Semantic, Procedural, Knowledge_Graph layers
    - Enforce tenant and principal isolation on all queries
    - Use JSON-only serialization (no pickle/code-executing formats)
    - Pass all writes through Governance_Service redaction pipeline
    - Return results capped at max count, ordered by relevance, with provenance metadata
    - Log embedding version with each persisted vector
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [~] 12.2 Write property tests for memory (Properties 7, 21, 22)
    - **Property 7: Tenant Data Isolation** — queries return only records matching authenticated tenant_id
    - **Property 21: Memory Serialization Safety** — only JSON/safe formats used, no code-executing serializers
    - **Property 22: Memory Retrieval Constraints** — results capped, ordered by relevance, include provenance
    - **Validates: Requirements 5.2, 5.3, 5.5**

  - [~] 12.3 Implement temporal memory weighting
    - Apply half-life decay per memory type (session summaries 30d, blockers 7d, goals 180d)
    - Apply frequency boost capped at configurable max (default 1.3)
    - Apply priority boost for "unresolved"/"active" status (default 1.4×)
    - Apply intent graph resonance boost for matching Intent_Node labels (default 1.5×)
    - Increment access counter on retrieval
    - _Requirements: 43.1, 43.2, 43.3, 43.4, 43.5, 43.6_

  - [~] 12.4 Write property tests for temporal memory weighting (Properties 67, 68, 69)
    - **Property 67: Temporal Memory Half-Life Decay** — memory at one half-life age has temporal score reduced by 50%
    - **Property 68: Memory Frequency Boost Cap** — frequency boost increases with access count but never exceeds max factor (default 1.3)
    - **Property 69: Memory Priority and Intent Resonance Boost** — unresolved/active gets 1.4× boost, matching Intent_Node labels get 1.5× boost
    - **Validates: Requirements 43.2, 43.3, 43.4, 43.5**

- [ ] 13. Implement Workflow_Service with durable execution
  - [~] 13.1 Implement workflow persistence, retry, and timeout enforcement
    - Implement CreateWorkflow, GetWorkflowStatus, PauseWorkflow, ResumeWorkflow, CancelWorkflow RPCs
    - Persist every state transition to durable storage
    - Resume in-progress workflows within 60s of restart
    - Enforce per-step and per-workflow timeouts and resource budgets
    - Implement retry with exponential backoff (delay = initial × multiplier^(attempt-1), capped at max)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [~] 13.2 Write property tests for workflow (Properties 31, 32)
    - **Property 31: Workflow State Persistence** — new state persisted before proceeding to next step
    - **Property 32: Workflow Step Retry with Exponential Backoff** — correct backoff formula applied
    - **Validates: Requirements 8.1, 8.4**

  - [~] 13.3 Implement workflow concurrency, confirmation gates, and simulation integration
    - Enforce per-tenant concurrency limit with backpressure
    - Pause workflow for HIGH/CRITICAL actions requiring Confirmation_Challenge
    - Invoke Simulation_Service for MEDIUM+ actions, present result with confirmation
    - Emit workflow-completion audit event with full step history
    - _Requirements: 8.5, 8.6, 8.7, 8.8_

  - [~] 13.4 Write property test for workflow concurrency (Property 33)
    - **Property 33: Workflow Concurrency Limit** — new workflows rejected with backpressure at max concurrent limit
    - **Validates: Requirements 8.6**

  - [~] 13.5 Implement multi-agent teams, 24h task manager, and dependency cycle detection
    - Implement CreateAgentTeam with defined roles (Research, Writer, Reviewer)
    - Implement inter-agent communication via documented message contracts
    - Implement 24h autonomous task manager with durable persistence and restart resume
    - Implement ValidateDependencyGraph with cycle detection, reject cyclic definitions
    - _Requirements: 8.9, 8.10, 8.11_

- [ ] 14. Implement Code_Sandbox_Service
  - [~] 14.1 Implement isolated code execution with resource limits
    - Execute code in isolated runtimes with resource limits
    - Support Python, JavaScript, TypeScript, Bash, SQL, Rust, Go
    - Enforce default-deny network egress, read-only host mounts
    - Terminate within 1s on timeout (default 30s, max 300s), memory cap (default 512MB, max 4096MB), or output cap (default 10MB, max 100MB)
    - Return structured result: stdout, stderr, exit_code, resource_usage, termination_reason, sandbox_id
    - Reject unsupported languages with UNSUPPORTED_LANGUAGE error
    - Refuse sensitive-path references
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [~] 14.2 Write property tests for code sandbox (Properties 24, 25, 26, 27, 28)
    - **Property 24: Code Sandbox Isolation** — isolated runtime with resource limits, deny-default egress, read-only mounts
    - **Property 25: Code Sandbox Resource Limit Enforcement** — terminate within 1s of breach
    - **Property 26: Code Sandbox Structured Result** — all required fields present
    - **Property 27: Unsupported Language Rejection** — reject with error, no execution
    - **Property 28: Sensitive Resource Denial** — refuse mount, return error
    - **Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.6**

  - [~] 14.3 Implement Git intelligence and IDE integration
    - Implement GitStatus, GitDiff, GitLog RPCs with read-only repo access
    - Implement GetIDEContext for VS Code integration (open files, selections, diagnostics, workspace config)
    - Implement AnalyzeCode for static analysis, dependency graphs, test generation
    - _Requirements: 6.7, 6.8, 6.9_

- [~] 15. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Implement Voice_Service
  - [~] 16.1 Implement speech-to-text and text-to-speech
    - Implement TranscribeStream with streaming STT, begin within 200ms of first frame after wake event
    - Achieve WER ≤10% on tenant's primary language Golden_Eval_Set
    - Include language identification and confidence score in transcription
    - Implement Synthesize with TTS latency ≤1500ms at p95 to first audio frame
    - Support Offline_Mode with tenant-boundary-only models
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.9_

- [ ] 17. Implement Vision_Service
  - [~] 17.1 Implement screen and webcam analysis with consent gating
    - Accept frames only with current consent record for corresponding sensor
    - Analyze only frames with pixel-difference above change threshold
    - Classify workflow context into ontology: {coding, browsing, writing, spreadsheet, communication, meeting, media, unknown}
    - Produce UserPresenceState (presence, gaze, eye-openness, head pose, time-in-state) every ≤5s
    - Discard biometric frames when tenant hasn't enabled biometric processing
    - Never persist raw frames beyond analysis duration
    - Support Offline_Mode with tenant-boundary models
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [~] 17.2 Write property tests for vision (Properties 47, 48)
    - **Property 47: Biometric Frame Discard** — discard frame, emit redaction audit, return without identification when biometric processing disabled
    - **Property 48: Workflow Context Classification Ontology** — classified value always from defined ontology set
    - **Validates: Requirements 3.3, 3.5**

- [ ] 18. Implement Emotion_Service
  - [~] 18.1 Implement multi-modal affect fusion with consent gating
    - Produce EmotionalState with valid ranges: valence [-1,1], arousal [0,1], stress [0,1], trend {improving, declining, stable}
    - Fuse only from consented sensor sources
    - Stop ingesting within 5s of consent revocation, discard in-memory frames
    - No export unless Tenant_Administrator enables integration
    - No protected attribute inferences (race, ethnicity, religion, etc.)
    - Read-only mode: inform style only, never override safety gates or Risk_Level
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [~] 18.2 Write property tests for emotion (Properties 29, 30, 104)
    - **Property 29: Emotional State Valid Ranges** — valence in [-1,1], arousal in [0,1], stress in [0,1], trend in valid set
    - **Property 30: No Protected Attribute Inference** — no inferences about race, ethnicity, religion, etc.
    - **Property 104: Emotion_Service Read-Only Mode** — estimates inform style only, never override safety/confirmation/risk
    - **Validates: Requirements 7.1, 7.4, 7.6**

- [ ] 19. Implement Habit_Service
  - [~] 19.1 Implement pattern learning with privacy controls
    - Learn patterns only from same End_User principal's event streams
    - Provide review surface listing patterns with origin, last-observed, confidence
    - Delete patterns within 60s on user request with audit event
    - No cross-user/cross-tenant pattern sharing
    - Disable predictions when tenant disables personalization
    - Integrate with POKG_Service for application co-occurrence patterns
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

- [ ] 20. Implement Cost_Service
  - [~] 20.1 Implement metering, attribution, and budget enforcement
    - Meter every billable event (model invocations, sandbox executions, storage)
    - Attribute to tenant_id and principal_id
    - Apply daily and monthly budgets with warning alerts at thresholds
    - Signal LLM_Gateway and Code_Sandbox_Service to reject on hard budget exceeded
    - Produce per-tenant/per-principal cost reports with daily granularity (retain 24 months)
    - _Requirements: 34.1, 34.2, 34.3, 34.4, 34.5_

  - [~] 20.2 Write property tests for cost (Properties 43, 44)
    - **Property 43: Usage Attribution** — every billable event correctly attributed to tenant_id and principal_id
    - **Property 44: Budget Alert Emission** — warning alert emitted at configured thresholds
    - **Validates: Requirements 34.1, 34.2**

- [~] 21. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 22. Implement Context_Intelligence_Service
  - [~] 22.1 Implement context packet assembly and provider management
    - Assemble Context_Packet every ≤60s from multiple signal sources
    - Assign Context_Confidence_Score [0.0, 1.0] to each field
    - Annotate fields with confidence <0.7 with uncertainty language
    - Inject Context_Packet into every LLM call via LLM_Gateway
    - Accept provider registrations, each contributing subset of fields
    - Consume ≤2% of one CPU core during assembly
    - On provider timeout (>5s): use cached value, reduce confidence by 0.2 (clamped to 0.0)
    - _Requirements: 36.1, 36.2, 36.3, 36.4, 36.5, 36.6, 36.7_

  - [~] 22.2 Write property tests for context intelligence (Properties 49, 50)
    - **Property 49: Context_Packet Field Completeness** — every field has confidence score in [0,1], fields <0.7 annotated with uncertainty
    - **Property 50: Context Provider Timeout Fallback** — on timeout, use cached value, reduce confidence by exactly 0.2 (clamped to 0.0)
    - **Validates: Requirements 36.3, 36.4, 36.7**

- [ ] 23. Implement Cognitive_State_Service
  - [~] 23.1 Implement cognitive state modeling and directive generation
    - Produce CognitiveState vector updated every ≤30s
    - All 7 fields in [0.0, 1.0]: focus_depth, interruption_tolerance, fatigue_score, task_switch_cost, cognitive_load, urgency_pressure, frustration_probability
    - Derive from observable signals (keystroke velocity, app switching, error frequency, session duration, calendar proximity, optional webcam)
    - Publish interruption tolerance to Proactive_Intelligence_Service
    - Generate cognitive directive for LLM prompts (extremely brief during deep focus, calm during high frustration)
    - Do not persist raw keystroke/webcam data beyond current update
    - Return default neutral state (all 0.5) when tenant disables feature
    - _Requirements: 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7_

  - [~] 23.2 Write property tests for cognitive state (Properties 51, 52)
    - **Property 51: Cognitive_State Vector Valid Ranges** — all 7 fields in [0.0, 1.0]
    - **Property 52: Cognitive State Directive Adaptation** — extremely brief when focus_depth >0.75, calm/solution-first when frustration >0.7
    - **Validates: Requirements 37.1, 37.5**

- [ ] 24. Implement Personality_Service
  - [~] 24.1 Implement adaptive personality with drift detection
    - Maintain immutable core character definition (values, constraints, prohibited behaviors)
    - Support 5 Style_Profiles: deep_work, casual_chat, late_night, high_stress, morning_briefing
    - Select profile based on Context_Packet (time, app) and CognitiveState (stress, focus)
    - Inject style directive into every LLM system prompt
    - Run drift benchmark every ≤7 days (≥20 prompts, LLM judge scoring)
    - Emit alert and revert to default on score <0.8 on any dimension
    - Support manual End_User override persisting until changed or next session
    - _Requirements: 38.1, 38.2, 38.3, 38.4, 38.5, 38.6, 38.7_

  - [~] 24.2 Write property tests for personality (Properties 53, 54, 55)
    - **Property 53: Style_Profile Selection Determinism** — exactly one profile selected for any context/state combination
    - **Property 54: Style Directive Matches Active Profile** — directive consistent with profile parameters
    - **Property 55: Personality Drift Detection Threshold** — alert and revert on score <0.8
    - **Validates: Requirements 38.3, 38.4, 38.6**

- [ ] 25. Implement Proactive_Intelligence_Service
  - [~] 25.1 Implement proactive signal scoring and delivery with interrupt budget
    - Enforce Interrupt_Budget (default 2/hour), override only when urgency >0.9
    - Suppress during deep focus (keystroke <5min AND focus_depth >0.75) unless urgency >0.9
    - Compute score = urgency × relevance × recency_factor, deliver only if > threshold (default 0.65)
    - Accept signals from calendar, habits, error detection, focus break
    - Log every delivered/suppressed signal to Audit_Service
    - Provide End_User config surface for budget, threshold, enabled sources
    - Increase threshold by 0.1 after 3 consecutive dismissals in session
    - _Requirements: 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.7_

  - [~] 25.2 Write property tests for proactive intelligence (Properties 56, 57, 58, 59)
    - **Property 56: Interrupt Budget Enforcement** — max configured signals per hour unless urgency >0.9
    - **Property 57: Deep Focus Suppression** — suppress during deep focus unless urgency >0.9
    - **Property 58: Proactive Signal Score Computation** — score = urgency × relevance × recency_factor, deliver only above threshold
    - **Property 59: Dismissal Threshold Adjustment** — threshold increases by 0.1 after 3 consecutive dismissals
    - **Validates: Requirements 39.1, 39.2, 39.3, 39.7**

- [~] 26. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 27. Implement Intent_Graph_Service
  - [~] 27.1 Implement intent graph with LLM extraction and context injection
    - Maintain directed graph with IntentNode types {project, goal, blocker, habit, deadline, frustration}
    - Maintain IntentEdge relations {blocks, requires, part_of, related_to, caused_by}
    - Extract nodes from conversations via LLM analysis
    - Inject top 5 most active nodes (ranked by priority × urgency × recency) into every LLM call
    - Update last_active when user context matches node
    - Isolate by tenant and principal
    - Provide review surface for editing priority, marking complete, deleting
    - On node deletion: remove node and all connected edges within 60s, emit audit event
    - _Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7_

  - [~] 27.2 Write property tests for intent graph (Properties 60, 61, 62)
    - **Property 60: Intent Graph Node Type Constraints** — node types from valid set, edge relations from valid set
    - **Property 61: Intent Graph Top-5 Injection** — exactly top 5 by composite score injected into LLM calls
    - **Property 62: Intent Node Deletion Cascades to Edges** — node and all connected edges removed within 60s
    - **Validates: Requirements 40.1, 40.3, 40.7**

- [ ] 28. Implement Knowledge_Grounding_Service
  - [~] 28.1 Implement freshness classification and web grounding
    - Classify queries into {TIMELESS, STABLE, VOLATILE}
    - Perform live web search for VOLATILE queries before responding
    - Fall back to web search for STABLE queries with confidence <0.85
    - Fuse web results with local RAG memory
    - Tag claims with Freshness_Tier and source
    - Apply prompt-injection defense to all web-sourced content
    - In Offline_Mode: skip web search, annotate with staleness warning
    - _Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7_

  - [~] 28.2 Write property tests for knowledge grounding (Properties 63, 64, 65)
    - **Property 63: Freshness Tier Classification Completeness** — every query classified into exactly one tier
    - **Property 64: VOLATILE Query Requires Live Web Search** — web search performed before response (staleness warning in Offline_Mode)
    - **Property 65: Web Content Prompt-Injection Defense** — all web content treated as untrusted, defense applied
    - **Validates: Requirements 41.1, 41.2, 41.6**

- [ ] 29. Implement POKG_Service
  - [~] 29.1 Implement personal operating knowledge graph
    - Record application co-occurrence sessions every 5 minutes
    - Mine frequent co-occurrence patterns, assign workflow labels
    - Identify current workflow type from active applications (predefined + learned patterns)
    - Track time-of-day patterns for schedule-based workflows
    - Track application transition patterns for workflow sequences
    - Provide workflow type and confidence to Context_Intelligence_Service
    - Isolate by tenant/principal, provide review surface for viewing/deleting patterns
    - _Requirements: 42.1, 42.2, 42.3, 42.4, 42.5, 42.6, 42.7_

  - [~] 29.2 Write property test for POKG (Property 66)
    - **Property 66: POKG Workflow Type Identification** — current workflow type identified from active apps against known and learned patterns
    - **Validates: Requirements 42.3**

- [ ] 30. Implement Goal_Engine_Service
  - [~] 30.1 Implement goal management with milestone decomposition
    - Create goals from natural language (title, description, motivation, priority, deadline, status)
    - Auto-decompose into 4-8 milestones via LLM (description, success criteria, estimated hours)
    - Track progress as completed_milestones / total_milestones
    - Detect blocked goals (no progress for configurable days, default 7)
    - Suggest optimal next action by scoring priority × inverse_progress × deadline_urgency
    - Execute weekly review producing structured summary
    - Support status transitions {active, paused, blocked, completed, abandoned} with audit events
    - Isolate by tenant and principal
    - _Requirements: 44.1, 44.2, 44.3, 44.4, 44.5, 44.6, 44.7, 44.8_

  - [~] 30.2 Write property tests for goal engine (Properties 70, 71, 72)
    - **Property 70: Goal Progress Ratio** — progress = completed_milestones / total_milestones
    - **Property 71: Blocked Goal Detection** — flagged as blocked after configured days with no progress
    - **Property 72: Goal Status Transition Validity** — status from valid set, audit event on each transition
    - **Validates: Requirements 44.3, 44.4, 44.7**

- [ ] 31. Implement Simulation_Service
  - [~] 31.1 Implement action outcome prediction
    - Generate SimulationResult for MEDIUM+ actions before confirmation gate
    - Include: predicted_outcome, success_probability [0,1], ≤3 failure_modes, expected_duration, rollback_cost, side_effects, resource_delta, confidence [0,1], recommendation
    - Derive from system state, historical success rates, LLM world model reasoning
    - Complete within 10s; on timeout return partial result with confidence=0.0, recommendation="proceed_with_caution"
    - Require explicit override when recommendation is "abort"
    - Log every result to Audit_Service
    - _Requirements: 45.1, 45.2, 45.3, 45.4, 45.5, 45.6, 45.7_

  - [~] 31.2 Write property tests for simulation (Properties 73, 74, 75)
    - **Property 73: Simulation_Result Structure Completeness** — all required fields present with valid ranges
    - **Property 74: Simulation Abort Recommendation Override** — explicit override required to proceed on "abort"
    - **Property 75: Simulation Timeout Handling** — partial result with confidence=0.0 on timeout >10s
    - **Validates: Requirements 45.2, 45.5, 45.6**

- [ ] 32. Implement Reflection_Service
  - [~] 32.1 Implement reflective reasoning with pattern detection
    - Compare predicted vs actual outcomes for MEDIUM+ actions and user-feedback actions
    - Produce reflection record: action description, intended/actual outcome, user signal, usefulness score, lesson
    - Identify failure patterns over configurable time windows
    - Feed lessons into Self_Improvement_Service weekly cycle
    - Persist with tenant/principal isolation, retain per tenant config (default 90 days)
    - _Requirements: 46.1, 46.2, 46.3, 46.4, 46.5_

  - [~] 32.2 Write property test for reflection (Property 76)
    - **Property 76: Reflection Record Completeness** — all required fields present in reflection record
    - **Validates: Requirements 46.2**

- [~] 33. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 34. Implement Planning_Service
  - [~] 34.1 Implement hierarchical planning with dependency management
    - Decompose goals into 3-level plan tree (strategic, tactical, operational)
    - Maintain dependency graph between nodes at each level
    - Detect cycles at plan creation time, reject with descriptive error
    - Execute bottom-up (leaf nodes first, progress as dependencies satisfied)
    - Replan affected subtree on node failure without regenerating entire plan
    - Provide human-readable checklist with status per level
    - Enforce per-plan and per-node timeout limits
    - _Requirements: 47.1, 47.2, 47.3, 47.4, 47.5, 47.6, 47.7_

  - [~] 34.2 Write property tests for planning (Properties 77, 78, 79)
    - **Property 77: Dependency Cycle Detection and Rejection** — cycles detected at plan time, rejected with descriptive error
    - **Property 78: Plan Execution Respects Dependencies** — no node begins until all dependencies completed
    - **Property 79: Subtree Replanning on Failure** — only affected subtree replanned
    - **Validates: Requirements 47.3, 47.4, 47.5**

- [ ] 35. Implement Plugin_Service
  - [~] 35.1 Implement sandboxed plugin execution with permission enforcement
    - Execute plugins in isolated subprocesses with resource limits
    - Require Plugin_Manifest (name, version, permissions, entry point, trigger phrases)
    - Grant only declared permissions from {network_outbound, speak, file_read, file_write, os_control, browser_control}
    - Require code signing, reject invalid/missing signatures
    - Enforce max execution time (default 15s), terminate on exceed
    - Treat plugin output as untrusted (apply output-filtering pipeline)
    - Emit audit event for every execution
    - Provide registry for Tenant_Administrators to approve/revoke/restrict plugins
    - _Requirements: 48.1, 48.2, 48.3, 48.4, 48.5, 48.6, 48.7, 48.8_

  - [~] 35.2 Write property tests for plugins (Properties 80, 81, 82, 83)
    - **Property 80: Plugin Permission Enforcement** — only declared permissions granted, undeclared denied
    - **Property 81: Plugin Code Signing Verification** — invalid/missing signatures rejected
    - **Property 82: Plugin Execution Time Limit** — terminate with TIMEOUT on exceed (default 15s)
    - **Property 83: Plugin Output Treated as Untrusted** — output subject to filtering, no core modification
    - **Validates: Requirements 48.3, 48.4, 48.5, 48.6**

- [ ] 36. Implement Self_Improvement_Service
  - [~] 36.1 Implement weekly improvement cycle with benchmark gating
    - Execute MEASURE/IDENTIFY/PROPOSE/TEST/DEPLOY cycle weekly
    - Maintain prompt versioning (≥10 recent versions retained)
    - Deploy only if benchmark score ≥ current production score
    - Record End_User corrections as input for IDENTIFY phase
    - Emit telemetry for each cycle (baseline, candidate, decision, versions)
    - Auto-rollback on score drop in next cycle
    - Require ≥10 corrections before initiating cycle
    - _Requirements: 49.1, 49.2, 49.3, 49.4, 49.5, 49.6, 49.7_

  - [~] 36.2 Write property tests for self-improvement (Properties 84, 85, 86)
    - **Property 84: Benchmark-Gated Deployment** — deploy only if score ≥ current, auto-rollback on drop
    - **Property 85: Version Retention** — ≥10 prompt versions retained
    - **Property 86: Minimum Corrections Before Improvement Cycle** — ≥10 corrections required
    - **Validates: Requirements 49.2, 49.3, 49.6, 49.7**

- [ ] 37. Implement Fine_Tuning_Service
  - [~] 37.1 Implement local LoRA fine-tuning with safety gates
    - All computation local-only, no external uploads
    - Require explicit End_User approval for every training data item (review gate)
    - Produce only LoRA_Adapter weights, never modify base model
    - Maintain adapter versioning (≥5 recent versions)
    - Run regression benchmark after every run, auto-rollback on score drop
    - Execute only at Throttle_Level NORMAL
    - Disable when tenant disables fine-tuning
    - _Requirements: 50.1, 50.2, 50.3, 50.4, 50.5, 50.6, 50.7_

  - [~] 37.2 Write property tests for fine-tuning (Properties 87, 88, 89, 90)
    - **Property 87: Fine-Tuning Local-Only Constraint** — no external uploads of data/weights
    - **Property 88: Fine-Tuning Review Gate** — explicit approval required for every training item
    - **Property 89: LoRA-Only Constraint** — only LoRA weights produced, base model unmodified
    - **Property 90: Throttle_Level Gating** — proceed only at NORMAL, research also requires no active interaction
    - **Validates: Requirements 50.1, 50.2, 50.3, 50.6**

- [ ] 38. Implement Research_Service
  - [~] 38.1 Implement autonomous research engine
    - Generate experiment hypotheses via LLM analysis (prompt effectiveness, model selection, context strategies)
    - Execute only at Throttle_Level NORMAL with no active user interaction
    - Evaluate against Eval_Service benchmarks, produce structured reports
    - Feed positive results into Self_Improvement_Service (never deploy directly)
    - Enforce max experiment time (default 30 min), terminate on exceed
    - Log all experiments to Audit_Service with tenant isolation
    - _Requirements: 51.1, 51.2, 51.3, 51.4, 51.5, 51.6, 51.7_

  - [~] 38.2 Write property test for research (Property 91)
    - **Property 91: Research Experiment No Direct Deployment** — positive results fed to Self_Improvement_Service, never deployed directly
    - **Validates: Requirements 51.4, 51.7**

- [~] 39. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 40. Implement Resource_Governor_Service
  - [~] 40.1 Implement resource monitoring and throttle level management
    - Monitor CPU, RAM, GPU, battery at intervals ≤3s
    - Enforce 4 Throttle_Levels: NORMAL, REDUCED, MINIMAL, EMERGENCY
    - Transition based on configurable thresholds with hysteresis (default 5% margin)
    - Publish current level to all services
    - Enforce max CPU ceiling for all Platform processes (default 25%)
    - Transition to EMERGENCY within 5s when CPU >85% or RAM >88%
    - Emit telemetry on every transition
    - _Requirements: 52.1, 52.2, 52.3, 52.4, 52.5, 52.6, 52.7_

  - [~] 40.2 Write property tests for resource governor (Properties 92, 93, 94)
    - **Property 92: Throttle_Level Valid Set** — always exactly one of {NORMAL, REDUCED, MINIMAL, EMERGENCY}
    - **Property 93: Throttle_Level Hysteresis** — resume higher level only when usage drops configurable margin below threshold
    - **Property 94: Emergency Throttle on Critical Resources** — transition to EMERGENCY within 5s on CPU >85% or RAM >88%
    - **Validates: Requirements 52.2, 52.3, 52.6**

- [ ] 41. Implement Watchdog_Service
  - [~] 41.1 Implement agent watchdog with recursion and timeout enforcement
    - Enforce max recursion depth (default 10), terminate on exceed
    - Enforce per-operation timeout (default 120s), terminate with TIMEOUT
    - Detect dependency graph cycles at plan time, reject before execution
    - Monitor agent resource consumption, terminate on budget exceed
    - Emit high-severity audit event on termination (agent_id, operation_id, reason, resource usage, elapsed time)
    - Provide health endpoint (active agents, longest-running, approaching limits)
    - _Requirements: 53.1, 53.2, 53.3, 53.4, 53.5, 53.6_

  - [~] 41.2 Write property tests for watchdog (Properties 95, 96)
    - **Property 95: Watchdog Recursion Limit Enforcement** — terminate on exceeding max depth, emit audit event
    - **Property 96: Watchdog Timeout Enforcement** — terminate on exceeding timeout, emit audit event
    - **Validates: Requirements 53.1, 53.2, 53.5**

- [ ] 42. Implement Compute_Fabric_Service
  - [~] 42.1 Implement distributed compute with GPU scheduling
    - Maintain resource inventory (CPU cores, GPU devices, VRAM, loaded models)
    - Route inference to optimal target based on complexity, latency, utilization, model availability
    - Manage model loading/unloading from GPU memory
    - Maintain priority queue (interactive > background)
    - Fall back to CPU or cloud on GPU exhaustion (if budget permits)
    - Respect Throttle_Level, reduce concurrency at REDUCED or lower
    - Emit telemetry for every allocation
    - _Requirements: 54.1, 54.2, 54.3, 54.4, 54.5, 54.6, 54.7_

  - [~] 42.2 Write property tests for compute fabric (Properties 97, 98)
    - **Property 97: Compute Fabric Priority Queue Ordering** — interactive prioritized over background, no background starts while interactive waits
    - **Property 98: Compute Fabric GPU Fallback** — fall back to CPU/cloud rather than failing when GPU unavailable
    - **Validates: Requirements 54.4, 54.5**

- [ ] 43. Implement Environment_Model_Service
  - [~] 43.1 Implement environment modeling and change detection
    - Maintain live model: hardware tier, GPU availability/VRAM, battery, power state, thermal, connectivity, monitors
    - Update every ≤30s
    - Classify physical environment {home_office, mobile, unknown}
    - Provide state to Compute_Fabric_Service and Context_Intelligence_Service
    - Emit event to Resource_Governor_Service within 5s of significant change
    - Apply consent/privacy controls, don't persist beyond current update
    - _Requirements: 55.1, 55.2, 55.3, 55.4, 55.5, 55.6_

  - [~] 43.2 Write property tests for environment model (Properties 99, 100)
    - **Property 99: Environment Classification Valid Set** — exactly one of {home_office, mobile, unknown}
    - **Property 100: Environment Significant Change Event** — event emitted within 5s of significant change
    - **Validates: Requirements 55.3, 55.5**

- [~] 44. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 45. Implement Edge_Agent
  - [~] 45.1 Implement Edge_Agent with consent, sensors, and offline capability
    - Implement NegotiateSession with API version negotiation
    - Implement sensor capture with consent gating (no capture without consent)
    - Display unobstructable on-screen indicator during capture
    - Implement pause control (disable all capture within 1s)
    - On consent revocation: stop capture, discard buffers, emit audit within 5s
    - Implement kill switch (disable sensors, halt actions, sign out)
    - Implement wake-word detection (emit event within 500ms), push-to-talk mode
    - Idle CPU ≤5% of one core over 60s window
    - Handle microphone unavailability (HUD error, exponential backoff retry capped at 60s)
    - Implement Offline_Mode with cryptographically signed indicator
    - Implement mTLS connection to backend
    - _Requirements: 1.1, 1.2, 1.7, 1.8, 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 10.2, 10.3_

  - [~] 45.2 Write property tests for sensor consent (Properties 9, 10, 11)
    - **Property 9: Sensor Consent Gating** — no capture/ingest/process without current consent
    - **Property 10: Consent Revocation Enforcement** — stop, discard, audit within 5s
    - **Property 11: Offline_Mode Resource Boundary** — only tenant-boundary resources used, no external transmission
    - **Validates: Requirements 23.1, 23.4, 23.5**

- [ ] 46. Implement HUD_Client
  - [~] 46.1 Implement HUD with status, controls, and cognitive-adaptive layout
    - Display Edge_Agent status {idle, listening, thinking, speaking, acting, paused, offline, error}
    - Provide pause/resume control (within 1s)
    - Provide kill switch
    - Display pending HIGH/CRITICAL actions with description, workflow, Risk_Level, Confirmation_Challenge
    - Display Offline_Mode indicator
    - Provide consent management surface
    - Adapt layout based on CognitiveState (reduce complexity when focus >0.75, suppress suggestions when interruption tolerance <0.25)
    - Show contextual suggestion chips when interruption tolerance >0.5, dismissible with single action
    - Display goal progress widget with active goals, progress, next actions
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_

- [ ] 47. Implement Eval_Service
  - [~] 47.1 Implement golden evaluation suite and quality gates
    - Maintain versioned Golden_Eval_Sets for STT accuracy, TTS intelligibility, model routing, memory retrieval, PII detection, prompt-injection defense
    - Execute eval sets on model/prompt changes, block on regression threshold breach
    - Support shadow comparison (candidate vs incumbent on same inputs)
    - Retain results ≥365 days
    - _Requirements: 29.1, 29.2, 29.3, 29.4, 29.5_

- [ ] 48. Implement multi-tenant isolation enforcement
  - [~] 48.1 Implement cross-cutting tenant isolation
    - Associate every persisted record with tenant_id
    - Include tenant_id constraint on every DB, vector store, object store, message bus query
    - Maintain per-tenant encryption keys (tenant A keys cannot decrypt tenant B data)
    - Deny cross-tenant access attempts with high-severity audit event
    - Carry tenant context through background jobs, schedulers, async workers
    - Enforce Data_Residency_Region on storage and processing
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [~] 48.2 Write property test for tenant isolation (Property 8)
    - **Property 8: Per-Tenant Cryptographic Isolation** — tenant A encryption keys cannot decrypt tenant B data
    - **Validates: Requirements 13.3**

- [ ] 49. Implement reliability patterns across all services
  - [~] 49.1 Implement timeouts, circuit breakers, backpressure, and idempotency
    - Apply configured timeout to every outbound network call (no indefinite waits)
    - Apply circuit breakers on all critical outbound dependencies
    - Apply backpressure on ingress queues (reject with RETRY_LATER on overload)
    - Persist work items before acknowledging receipt
    - Produce idempotency keys on every state-changing API
    - Implement graceful degradation with documented fallback per dependency
    - _Requirements: 31.1, 31.2, 31.3, 31.4, 31.5, 31.6_

  - [~] 49.2 Write property tests for reliability (Properties 41, 42)
    - **Property 41: Backpressure on Queue Overload** — reject with RETRY_LATER when threshold exceeded
    - **Property 42: Durable Persistence Before Acknowledgment** — persist before ack for reliable operations
    - **Validates: Requirements 31.3, 31.4**

- [~] 50. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 51. Implement containerization and infrastructure-as-code
  - [~] 51.1 Create Dockerfiles and container configurations
    - Create Dockerfile for each backend service
    - Create docker-compose configuration for local dev/integration testing
    - Create Helm chart or Kustomize manifests for Kubernetes deployment
    - Create infrastructure-as-code for cloud resources (storage, databases, KMS, network policy)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [~] 51.2 Create Edge_Agent installer and deployment pipeline
    - Create signed installation packages for Windows, macOS, Linux
    - Document uninstall procedure
    - Implement independent versioning from backend services
    - _Requirements: 15.5, 14.6_

- [ ] 52. Implement CI/CD pipeline and supply chain security
  - [~] 52.1 Set up CI pipeline with quality gates
    - Execute on every PR: unit tests, lint, type checks, container build, dependency vuln scan, image scan, secret scan, license scan, SBOM generation
    - Block merge on failed required checks
    - Execute integration tests and eval regression on release candidates
    - Produce signed provenance attestation on promotion
    - Deploy only via CD pipeline (no manual uploads except break-glass)
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [~] 52.2 Implement supply chain security controls
    - Pin all dependencies with cryptographic hashes in lock files
    - Produce CycloneDX/SPDX SBOM for every release
    - Run vuln scanning on every PR and daily, fail on HIGH/CRITICAL without exception
    - Sign artifacts with Sigstore-compatible scheme, SLSA Level 3+ provenance
    - Verify signature and provenance before production admission
    - Document incident response for supply-chain advisories (7-day mitigation target)
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6_

- [ ] 53. Implement backup, restore, and disaster recovery
  - [~] 53.1 Implement backup and DR procedures
    - Produce backups satisfying RPO ≤1h for memory/workflow/audit, ≤24h for telemetry
    - Store in isolated storage with separate credentials and retention policy
    - Encrypt backups with Secrets_Service keys
    - Define RTO ≤4h, test restore every ≤90 days
    - Verify integrity with cryptographic checksums, emit audit on restore
    - Document DR plan with regional failover, communication, escalation
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.6_

- [ ] 54. Implement security hardening and threat model
  - [~] 54.1 Implement threat model and security controls
    - Document threat model covering: malicious End_User, compromised workstation, malicious insider, malicious model provider, network attacker, malicious dependency
    - Document mitigations, responsible services, verification mechanisms per threat
    - Enforce default-deny network egress with per-service allowlists
    - Schedule penetration testing/red-team every ≤12 months
    - _Requirements: 20.1, 20.2, 20.5, 20.6_

- [ ] 55. Implement incident response and operational readiness
  - [~] 55.1 Create runbooks, incident response, and documentation
    - Create runbook for every alertable condition (detection, diagnosis, mitigation, verification)
    - Document incident severity scale, escalation policy, on-call rotation
    - Define postmortem process (7-day SLA for SEV1/SEV2)
    - Track corrective actions to closure
    - Document security incident response with notification obligations
    - _Requirements: 33.1, 33.2, 33.3, 33.4, 33.5_

  - [~] 55.2 Create operational documentation
    - Operator handbook (deployment, config, observability, alerts, backup, DR)
    - Tenant_Administrator handbook (provisioning, federation, policy, DSAR, reporting)
    - End_User guide (wake phrase, interaction, consent, pause, kill switch, privacy)
    - Architecture document (service boundaries, data flows, schemas, topology, security)
    - API reference generated from machine-readable specs, updated per release
    - _Requirements: 35.1, 35.2, 35.3, 35.4, 35.5_

- [ ] 56. Implement compliance mapping
  - [~] 56.1 Create compliance control mappings and DPIA
    - Map requirements to SOC 2 Trust Services Criteria and ISO 27001:2022 Annex A
    - Document DPIA for sensor capture, biometric, emotional inference, profiling
    - Maintain Records of Processing Activities (GDPR Article 30)
    - Produce evidence artifacts per control (config snapshots, audit samples, test results)
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5_

- [ ] 57. Integration wiring and end-to-end flows
  - [~] 57.1 Wire all services together with request context propagation
    - Implement RequestContext propagation across all services (tenant_id, principal_id, correlation_id, trace_context, session_id, roles, attributes, residency_region)
    - Wire Edge_Agent → API Gateway → all backend services
    - Wire event bus (authenticated, mTLS) for async events (audit, telemetry, workflow triggers)
    - Wire Context_Intelligence_Service → LLM_Gateway context injection
    - Wire Cognitive_State_Service → Proactive_Intelligence_Service interrupt tolerance
    - Wire Personality_Service → LLM_Gateway style directive injection
    - Wire Intent_Graph_Service → LLM_Gateway strategic context injection
    - Wire POKG_Service → Context_Intelligence_Service workflow type
    - Wire Simulation_Service → Control_Service/Workflow_Service pre-execution prediction
    - Wire Reflection_Service → Self_Improvement_Service lessons
    - Wire Research_Service → Self_Improvement_Service positive results
    - Wire Resource_Governor_Service → all services throttle level
    - Wire Environment_Model_Service → Resource_Governor_Service + Compute_Fabric_Service
    - _Requirements: 14.3, 36.2, 37.4, 38.4, 40.3, 42.6, 45.1, 46.5, 51.4, 52.4, 55.4_

  - [~] 57.2 Write integration tests for end-to-end flows
    - Test voice pipeline: wake word → STT → LLM → TTS
    - Test action execution: request → authorize → simulate → confirm → execute → audit
    - Test workflow execution across service boundaries
    - Test cross-service correlation_id propagation
    - Test context assembly with multiple providers
    - Test proactive signal delivery pipeline
    - Test goal decomposition and weekly review
    - Test plugin sandboxed execution
    - Test self-improvement full cycle
    - Test resource governor throttle transitions under load
    - _Requirements: 1.1-1.9, 2.1-2.15, 8.1-8.11, 36.1-36.7, 39.1-39.7, 44.1-44.8, 48.1-48.8, 49.1-49.7, 52.1-52.7_

- [~] 58. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate universal correctness properties from the design document (104 properties total)
- Unit tests validate specific examples and edge cases
- TypeScript is used throughout with fast-check for property-based testing
- The platform comprises 35+ services; tasks are ordered to build foundational services first (identity, audit, governance, secrets) before dependent services
- All services communicate via mTLS/gRPC with RequestContext propagation
- Tenant isolation is a cross-cutting concern enforced at every layer

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6"] },
    { "id": 2, "tasks": ["2.1", "6.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.7"] },
    { "id": 4, "tasks": ["2.4", "2.5"] },
    { "id": 5, "tasks": ["2.6", "4.1"] },
    { "id": 6, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 7, "tasks": ["5.1", "5.3", "5.5", "7.1"] },
    { "id": 8, "tasks": ["5.2", "5.4", "5.6", "7.2"] },
    { "id": 9, "tasks": ["9.1", "9.4"] },
    { "id": 10, "tasks": ["9.2", "9.6", "9.8"] },
    { "id": 11, "tasks": ["9.3", "9.5", "9.7", "9.9"] },
    { "id": 12, "tasks": ["10.1", "10.3", "10.5"] },
    { "id": 13, "tasks": ["10.2", "10.4", "10.6"] },
    { "id": 14, "tasks": ["12.1", "12.3", "13.1", "13.3", "13.5"] },
    { "id": 15, "tasks": ["12.2", "12.4", "13.2", "13.4"] },
    { "id": 16, "tasks": ["14.1", "14.3", "16.1", "17.1"] },
    { "id": 17, "tasks": ["14.2", "17.2", "18.1", "19.1"] },
    { "id": 18, "tasks": ["18.2", "20.1"] },
    { "id": 19, "tasks": ["20.2", "22.1"] },
    { "id": 20, "tasks": ["22.2", "23.1"] },
    { "id": 21, "tasks": ["23.2", "24.1"] },
    { "id": 22, "tasks": ["24.2", "25.1"] },
    { "id": 23, "tasks": ["25.2", "27.1", "28.1", "29.1"] },
    { "id": 24, "tasks": ["27.2", "28.2", "29.2", "30.1"] },
    { "id": 25, "tasks": ["30.2", "31.1", "32.1"] },
    { "id": 26, "tasks": ["31.2", "32.2", "34.1"] },
    { "id": 27, "tasks": ["34.2", "35.1", "36.1", "37.1", "38.1"] },
    { "id": 28, "tasks": ["35.2", "36.2", "37.2", "38.2"] },
    { "id": 29, "tasks": ["40.1", "41.1", "42.1", "43.1"] },
    { "id": 30, "tasks": ["40.2", "41.2", "42.2", "43.2"] },
    { "id": 31, "tasks": ["45.1", "46.1", "47.1"] },
    { "id": 32, "tasks": ["45.2", "48.1", "49.1"] },
    { "id": 33, "tasks": ["48.2", "49.2", "51.1", "51.2"] },
    { "id": 34, "tasks": ["52.1", "52.2", "53.1", "54.1"] },
    { "id": 35, "tasks": ["55.1", "55.2", "56.1"] },
    { "id": 36, "tasks": ["57.1"] },
    { "id": 37, "tasks": ["57.2"] }
  ]
}
```
