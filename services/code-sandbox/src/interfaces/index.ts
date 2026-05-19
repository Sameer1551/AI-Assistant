/**
 * Code Sandbox Service interfaces and types.
 *
 * @see Requirements 6.1–6.9
 */

/** Supported programming languages. */
export type SupportedLanguage = 'python' | 'javascript' | 'typescript' | 'bash' | 'sql' | 'rust' | 'go';

export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set<SupportedLanguage>([
  'python', 'javascript', 'typescript', 'bash', 'sql', 'rust', 'go',
]);

/** Sensitive host paths that must never be mounted or referenced. */
export const SENSITIVE_PATHS = [
  '/etc/passwd', '/etc/shadow', '/etc/hosts', '/root', '/home',
  '/proc', '/sys', '/dev', 'C:\\Windows', 'C:\\Users',
  '.ssh', '.aws', '.env', '.git/config',
];

/** Reason for execution termination. */
export type TerminationReason = 'completed' | 'timeout' | 'memory_limit' | 'output_limit' | 'error' | 'sensitive_path_denied';

export interface ResourceUsage {
  readonly wall_time_ms: number;
  readonly memory_peak_mb: number;
  readonly output_bytes: number;
}

/** Structured result returned by the sandbox after code execution. */
export interface SandboxExecutionResult {
  readonly sandbox_id: string;
  readonly language: string;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly resource_usage: ResourceUsage;
  readonly termination_reason: TerminationReason;
}

/** Resource limits for a sandbox execution. */
export interface SandboxLimits {
  readonly timeout_seconds: number;       // default 30, max 300
  readonly memory_limit_mb: number;       // default 512, max 4096
  readonly output_limit_bytes: number;    // default 10MB, max 100MB
  readonly network_egress: 'deny' | 'allow';
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeout_seconds: 30,
  memory_limit_mb: 512,
  output_limit_bytes: 10 * 1024 * 1024, // 10MB
  network_egress: 'deny',
};

export const MAX_SANDBOX_LIMITS: SandboxLimits = {
  timeout_seconds: 300,
  memory_limit_mb: 4096,
  output_limit_bytes: 100 * 1024 * 1024, // 100MB
  network_egress: 'deny',
};

export interface ExecuteCodeRequest {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly language: string;
  readonly code: string;
  readonly limits?: Partial<SandboxLimits>;
  readonly correlation_id: string;
}

/** Git intelligence types */
export interface GitStatusResult {
  readonly branch: string;
  readonly modified: readonly string[];
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  readonly untracked: readonly string[];
}

export interface GitDiffResult {
  readonly diff: string;
  readonly files_changed: number;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly message: string;
}

export interface IDEContext {
  readonly open_files: readonly string[];
  readonly active_file?: string;
  readonly diagnostics: readonly { file: string; message: string; severity: string }[];
}

export interface CodeAnalysisResult {
  readonly issues: readonly { line: number; message: string; severity: string }[];
  readonly dependencies: readonly string[];
  readonly complexity_score: number;
}

export interface ICodeSandboxService {
  execute(request: ExecuteCodeRequest): Promise<SandboxExecutionResult>;
  gitStatus(repoPath: string, tenantId: string): Promise<GitStatusResult>;
  gitDiff(repoPath: string, tenantId: string): Promise<GitDiffResult>;
  gitLog(repoPath: string, tenantId: string, limit?: number): Promise<readonly GitLogEntry[]>;
  getIDEContext(tenantId: string): Promise<IDEContext>;
  analyzeCode(code: string, language: string, tenantId: string): Promise<CodeAnalysisResult>;
}

export interface ISandboxIdGenerator {
  uuid(): string;
}

export interface ISandboxClock {
  nowISO(): string;
}
