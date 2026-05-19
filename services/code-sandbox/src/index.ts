/**
 * @may/code-sandbox — Code Sandbox Service entry point
 */

export { CodeSandboxService } from './code-sandbox-service.js';
export type { IExecutionAdapter } from './code-sandbox-service.js';
export {
  SUPPORTED_LANGUAGES,
  SENSITIVE_PATHS,
  DEFAULT_SANDBOX_LIMITS,
  MAX_SANDBOX_LIMITS,
} from './interfaces/index.js';
export type {
  ICodeSandboxService,
  ExecuteCodeRequest,
  SandboxExecutionResult,
  SandboxLimits,
  SupportedLanguage,
  TerminationReason,
  GitStatusResult,
  GitDiffResult,
  GitLogEntry,
  IDEContext,
  CodeAnalysisResult,
} from './interfaces/index.js';
