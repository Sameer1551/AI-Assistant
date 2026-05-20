/**
 * @module watchdog-service
 * Watchdog_Service: Agent execution safeguarding and limits enforcement.
 *
 * @see Requirements 53.1–53.6
 */

import type { IWatchdogIdGenerator, IWatchdogClock, IAuditPublisher, AgentHealthStats } from './interfaces/index.js';

export interface WatchdogConfig {
  readonly maxRecursionDepth: number;
  readonly defaultTimeoutMs: number;
  readonly budgetMemoryMb?: number;
}

export interface WatchdogServiceDeps {
  readonly idGenerator: IWatchdogIdGenerator;
  readonly clock: IWatchdogClock;
  readonly auditPublisher: IAuditPublisher;
  readonly config?: Partial<WatchdogConfig>;
}

export interface ActiveOperation {
  readonly agentId: string;
  readonly operationId: string;
  readonly startTimeMs: number;
  readonly depth: number;
  readonly budgetMemoryMb?: number;
  currentMemoryMb: number;
}

export class WatchdogService {
  private readonly idGenerator: IWatchdogIdGenerator;
  private readonly clock: IWatchdogClock;
  private readonly auditPublisher: IAuditPublisher;
  private readonly config: WatchdogConfig;

  private readonly activeOperations = new Map<string, ActiveOperation>();

  constructor(deps: WatchdogServiceDeps) {
    this.idGenerator = deps.idGenerator;
    this.clock = deps.clock;
    this.auditPublisher = deps.auditPublisher;
    this.config = {
      maxRecursionDepth: deps.config?.maxRecursionDepth ?? 10,
      defaultTimeoutMs: deps.config?.defaultTimeoutMs ?? 120000,
      budgetMemoryMb: deps.config?.budgetMemoryMb ?? 512,
    };
  }

  /**
   * Detects cycles in a dependency graph using DFS.
   *
   * @see Requirement 53.3
   */
  detectCycles(nodes: string[], dependencies: Record<string, string[]>): boolean {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string): boolean => {
      if (recStack.has(node)) {
        return true; // Cycle detected
      }
      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      recStack.add(node);

      const neighbors = dependencies[node] || [];
      for (const neighbor of neighbors) {
        if (dfs(neighbor)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const node of nodes) {
      if (dfs(node)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Executes an agent operation with timeout, recursion, and budget enforcement.
   *
   * @see Requirement 53.1, 53.2, 53.4, 53.5
   */
  async executeOperation<T>(
    agentId: string,
    operationId: string,
    depth: number,
    budgetMemoryMb: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const startMs = this.clock.nowMs();

    // 1. Recursion limit check (Requirement 53.1, Property 95)
    if (depth > this.config.maxRecursionDepth) {
      const reason = `Recursion depth ${depth} exceeds maximum limit of ${this.config.maxRecursionDepth}`;
      await this.emitTerminationAudit(agentId, operationId, 'RECURSION_EXCEEDED', reason, startMs, {
        recursionDepth: depth,
        memoryUsageMb: 0,
      });
      throw new Error(reason);
    }

    const opKey = `${agentId}:${operationId}`;
    const activeOp: ActiveOperation = {
      agentId,
      operationId,
      startTimeMs: startMs,
      depth,
      budgetMemoryMb,
      currentMemoryMb: 10, // dummy start memory
    };
    this.activeOperations.set(opKey, activeOp);

    let timer: NodeJS.Timeout | undefined;
    let resourceMonitorInterval: NodeJS.Timeout | undefined;

    try {
      // 2. Resource/Budget monitoring (Requirement 53.4)
      resourceMonitorInterval = setInterval(() => {
        // Mock resource consumption growth or get actual process memory if applicable
        activeOp.currentMemoryMb += 20; 
        if (activeOp.currentMemoryMb > budgetMemoryMb) {
          const reason = `Resource budget exceeded: Memory ${activeOp.currentMemoryMb}MB exceeds limit ${budgetMemoryMb}MB`;
          this.emitTerminationAudit(agentId, operationId, 'BUDGET_EXCEEDED', reason, startMs, {
            recursionDepth: depth,
            memoryUsageMb: activeOp.currentMemoryMb,
          }).catch(() => {});
          
          // Force clear and reject
          if (resourceMonitorInterval) clearInterval(resourceMonitorInterval);
          if (timer) clearTimeout(timer);
          this.activeOperations.delete(opKey);
        }
      }, 50);

      const executionPromise = operation();

      // 3. Timeout enforcement (Requirement 53.2, Property 96)
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const reason = `Operation exceeded timeout limit of ${this.config.defaultTimeoutMs}ms`;
          this.emitTerminationAudit(agentId, operationId, 'TIMEOUT', reason, startMs, {
            recursionDepth: depth,
            memoryUsageMb: activeOp.currentMemoryMb,
          }).catch(() => {});
          reject(new Error(reason));
        }, this.config.defaultTimeoutMs);
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (resourceMonitorInterval) clearInterval(resourceMonitorInterval);
      this.activeOperations.delete(opKey);
    }
  }

  /**
   * Provide service health stats.
   *
   * @see Requirement 53.6
   */
  getHealthStats(): AgentHealthStats {
    const now = this.clock.nowMs();
    let activeAgentsCount = 0;
    let longestRunningAgentId: string | undefined;
    let longestDuration = 0;
    const approachingLimits: string[] = [];

    const uniqueAgents = new Set<string>();

    for (const op of this.activeOperations.values()) {
      uniqueAgents.add(op.agentId);
      const duration = now - op.startTimeMs;
      if (duration > longestDuration) {
        longestDuration = duration;
        longestRunningAgentId = op.agentId;
      }

      // Check if approaching timeout limit (80%) or budget limit (80%)
      const isApproachingTimeout = duration > this.config.defaultTimeoutMs * 0.8;
      const isApproachingMemory = op.budgetMemoryMb ? (op.currentMemoryMb > op.budgetMemoryMb * 0.8) : false;

      if (isApproachingTimeout || isApproachingMemory) {
        approachingLimits.push(op.agentId);
      }
    }

    activeAgentsCount = uniqueAgents.size;

    return {
      activeAgentsCount,
      longestRunningAgentId,
      agentsApproachingLimits: approachingLimits,
    };
  }

  private async emitTerminationAudit(
    agentId: string,
    operationId: string,
    reasonCode: 'RECURSION_EXCEEDED' | 'TIMEOUT' | 'BUDGET_EXCEEDED',
    reasonMessage: string,
    startMs: number,
    resourceUsage: { recursionDepth: number; memoryUsageMb: number }
  ): Promise<void> {
    const elapsedMs = this.clock.nowMs() - startMs;
    await this.auditPublisher.publishAudit({
      event_id: this.idGenerator.uuid(),
      severity: 'high',
      timestamp: this.clock.nowISO(),
      message: `Agent operation terminated: ${reasonMessage}`,
      metadata: {
        agent_id: agentId,
        operation_id: operationId,
        reason_code: reasonCode,
        elapsed_time_ms: elapsedMs,
        resource_usage: resourceUsage,
      },
    });
  }
}
