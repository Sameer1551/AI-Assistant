/**
 * @module dependency-graph
 * Dependency graph validation with cycle detection for workflow steps.
 *
 * Uses DFS with three-state coloring (white/gray/black) to detect cycles.
 * Cycle detection runs at workflow creation time; cyclic definitions are rejected.
 *
 * @see Requirement 8.11 — ValidateDependencyGraph with cycle detection
 */

export interface GraphNode {
  readonly step_id: string;
  readonly dependencies: readonly string[];
}

type Color = 'white' | 'gray' | 'black';

/**
 * Validate a dependency graph for cycles.
 *
 * @param steps - Array of steps with their declared dependencies
 * @returns true if the graph is a valid DAG (no cycles), false if a cycle exists
 */
export function isValidDAG(steps: readonly GraphNode[]): boolean {
  const colors = new Map<string, Color>();
  const adj = new Map<string, readonly string[]>();

  for (const step of steps) {
    colors.set(step.step_id, 'white');
    adj.set(step.step_id, step.dependencies);
  }

  function dfs(nodeId: string): boolean {
    colors.set(nodeId, 'gray');
    const neighbors = adj.get(nodeId) ?? [];
    for (const neighbor of neighbors) {
      if (!colors.has(neighbor)) continue; // unknown node reference — ignore
      if (colors.get(neighbor) === 'gray') return false; // back edge = cycle
      if (colors.get(neighbor) === 'white' && !dfs(neighbor)) return false;
    }
    colors.set(nodeId, 'black');
    return true;
  }

  for (const step of steps) {
    if (colors.get(step.step_id) === 'white') {
      if (!dfs(step.step_id)) return false;
    }
  }

  return true;
}
