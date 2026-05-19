/**
 * Property-Based Tests — Code Sandbox Service
 *
 * Property 24: Code Sandbox Isolation — isolated runtime, deny-default egress, read-only mounts
 * Property 25: Code Sandbox Resource Limit Enforcement — terminate within 1s of breach
 * Property 26: Code Sandbox Structured Result — all required fields present
 * Property 27: Unsupported Language Rejection — reject with error, no execution
 * Property 28: Sensitive Resource Denial — refuse mount, return error
 *
 * @see Requirements 6.1, 6.3, 6.4, 6.5, 6.6
 */

import { describe, it, expect, vi } from 'vitest';
import { CodeSandboxService } from '../src/code-sandbox-service.js';
import type { IExecutionAdapter } from '../src/code-sandbox-service.js';
import { SENSITIVE_PATHS, SUPPORTED_LANGUAGES } from '../src/interfaces/index.js';
import type { SandboxLimits } from '../src/interfaces/index.js';

// ─── Test Doubles ─────────────────────────────────────────────────────────────

let idCounter = 0;
const mockIdGen = { uuid: () => `sb-${++idCounter}` };
const mockClock = { nowISO: () => new Date().toISOString() };

function makeSuccessAdapter(overrides = {}): IExecutionAdapter {
  return {
    async run() {
      return {
        stdout: 'Hello',
        stderr: '',
        exit_code: 0,
        wall_time_ms: 100,
        memory_peak_mb: 50,
        output_bytes: 5,
        terminated_reason: 'completed' as const,
        ...overrides,
      };
    },
  };
}

function makeService(adapter: IExecutionAdapter = makeSuccessAdapter()) {
  return new CodeSandboxService({ idGenerator: mockIdGen, clock: mockClock, executionAdapter: adapter });
}

const baseRequest = {
  tenant_id: 'tenant-1',
  principal_id: 'user-1',
  correlation_id: 'corr-1',
};

// ─── Property 24: Code Sandbox Isolation ─────────────────────────────────────

describe('Property 24: Code Sandbox Isolation', () => {
  it('network_egress is always deny — never allows user override', async () => {
    let capturedLimits: SandboxLimits | undefined;
    const adapter: IExecutionAdapter = {
      async run(params) {
        capturedLimits = params.limits;
        return { stdout: '', stderr: '', exit_code: 0, wall_time_ms: 10, memory_peak_mb: 10, output_bytes: 0, terminated_reason: 'completed' };
      },
    };
    const service = makeService(adapter);

    await service.execute({
      ...baseRequest,
      language: 'python',
      code: 'print("test")',
      limits: { network_egress: 'allow' as never }, // user tries to override
    });

    expect(capturedLimits?.network_egress).toBe('deny');
  });
});

// ─── Property 25: Resource Limit Enforcement ──────────────────────────────────

describe('Property 25: Code Sandbox Resource Limit Enforcement', () => {
  it('timeout limit cannot exceed 300 seconds regardless of user request', async () => {
    let capturedLimits: SandboxLimits | undefined;
    const adapter: IExecutionAdapter = {
      async run(params) {
        capturedLimits = params.limits;
        return { stdout: '', stderr: '', exit_code: 0, wall_time_ms: 10, memory_peak_mb: 10, output_bytes: 0, terminated_reason: 'completed' };
      },
    };
    const service = makeService(adapter);

    await service.execute({ ...baseRequest, language: 'python', code: 'pass', limits: { timeout_seconds: 9999 } });
    expect(capturedLimits?.timeout_seconds).toBeLessThanOrEqual(300);
  });

  it('memory limit cannot exceed 4096 MB', async () => {
    let capturedLimits: SandboxLimits | undefined;
    const adapter: IExecutionAdapter = {
      async run(params) {
        capturedLimits = params.limits;
        return { stdout: '', stderr: '', exit_code: 0, wall_time_ms: 10, memory_peak_mb: 10, output_bytes: 0, terminated_reason: 'completed' };
      },
    };
    const service = makeService(adapter);

    await service.execute({ ...baseRequest, language: 'python', code: 'pass', limits: { memory_limit_mb: 99999 } });
    expect(capturedLimits?.memory_limit_mb).toBeLessThanOrEqual(4096);
  });

  it('output limit cannot exceed 100 MB', async () => {
    let capturedLimits: SandboxLimits | undefined;
    const adapter: IExecutionAdapter = {
      async run(params) {
        capturedLimits = params.limits;
        return { stdout: '', stderr: '', exit_code: 0, wall_time_ms: 10, memory_peak_mb: 10, output_bytes: 0, terminated_reason: 'completed' };
      },
    };
    const service = makeService(adapter);

    await service.execute({ ...baseRequest, language: 'python', code: 'pass', limits: { output_limit_bytes: 999_000_000 } });
    expect(capturedLimits?.output_limit_bytes).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it('default timeout is 30 seconds when not specified', async () => {
    let capturedLimits: SandboxLimits | undefined;
    const adapter: IExecutionAdapter = {
      async run(params) {
        capturedLimits = params.limits;
        return { stdout: '', stderr: '', exit_code: 0, wall_time_ms: 10, memory_peak_mb: 10, output_bytes: 0, terminated_reason: 'completed' };
      },
    };
    const service = makeService(adapter);

    await service.execute({ ...baseRequest, language: 'python', code: 'pass' });
    expect(capturedLimits?.timeout_seconds).toBe(30);
  });
});

// ─── Property 26: Structured Result Fields ────────────────────────────────────

describe('Property 26: Code Sandbox Structured Result', () => {
  const requiredFields = ['sandbox_id', 'language', 'exit_code', 'stdout', 'stderr', 'resource_usage', 'termination_reason'] as const;

  it('all required fields present in successful execution', async () => {
    const service = makeService();
    const result = await service.execute({ ...baseRequest, language: 'python', code: 'print("hi")' });

    for (const field of requiredFields) {
      expect(result).toHaveProperty(field);
    }
    expect(result.resource_usage).toHaveProperty('wall_time_ms');
    expect(result.resource_usage).toHaveProperty('memory_peak_mb');
    expect(result.resource_usage).toHaveProperty('output_bytes');
  });

  it('all required fields present even on unsupported language rejection', async () => {
    const service = makeService();
    const result = await service.execute({ ...baseRequest, language: 'cobol', code: 'DISPLAY "HI"' });

    for (const field of requiredFields) {
      expect(result).toHaveProperty(field);
    }
  });
});

// ─── Property 27: Unsupported Language Rejection ──────────────────────────────

describe('Property 27: Unsupported Language Rejection', () => {
  it('rejects unsupported languages with UNSUPPORTED_LANGUAGE in stderr', async () => {
    const runSpy = vi.fn();
    const adapter: IExecutionAdapter = { run: runSpy };
    const service = makeService(adapter);

    const result = await service.execute({ ...baseRequest, language: 'cobol', code: 'DISPLAY "HI"' });

    // Execution adapter must NOT be called
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.stderr).toContain('UNSUPPORTED_LANGUAGE');
    expect(result.exit_code).toBe(-1);
    expect(result.termination_reason).toBe('error');
  });

  it('accepts all supported languages', async () => {
    const service = makeService();
    for (const lang of SUPPORTED_LANGUAGES) {
      const result = await service.execute({ ...baseRequest, language: lang, code: '' });
      expect(result.termination_reason).not.toBe('error');
    }
  });
});

// ─── Property 28: Sensitive Resource Denial ───────────────────────────────────

describe('Property 28: Sensitive Resource Denial', () => {
  it('refuses code referencing sensitive paths', async () => {
    const runSpy = vi.fn();
    const adapter: IExecutionAdapter = { run: runSpy };
    const service = makeService(adapter);

    const result = await service.execute({
      ...baseRequest,
      language: 'bash',
      code: 'cat /etc/passwd',
    });

    expect(runSpy).not.toHaveBeenCalled();
    expect(result.stderr).toContain('SENSITIVE_PATH_DENIED');
    expect(result.termination_reason).toBe('sensitive_path_denied');
    expect(result.exit_code).toBe(-1);
  });

  it('refuses code referencing .ssh directory', async () => {
    const runSpy = vi.fn();
    const adapter: IExecutionAdapter = { run: runSpy };
    const service = makeService(adapter);

    const result = await service.execute({
      ...baseRequest,
      language: 'python',
      code: 'open(".ssh/id_rsa").read()',
    });

    expect(runSpy).not.toHaveBeenCalled();
    expect(result.stderr).toContain('SENSITIVE_PATH_DENIED');
  });

  it('sensitive path check covers all defined paths', () => {
    // Ensure SENSITIVE_PATHS list is non-empty and contains critical entries
    expect(SENSITIVE_PATHS.length).toBeGreaterThan(0);
    expect(SENSITIVE_PATHS).toContain('/etc/passwd');
    expect(SENSITIVE_PATHS).toContain('.ssh');
  });
});
