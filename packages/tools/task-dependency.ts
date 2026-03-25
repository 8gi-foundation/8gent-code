/**
 * Task Dependency Resolver
 *
 * Resolves task execution order from a dependency graph.
 * Supports cycle detection and parallel group extraction.
 */

export interface TaskNode {
  name: string;
  deps: string[];
}

export class DependencyResolver {
  private tasks: Map<string, Set<string>> = new Map();

  /** Register a task with optional dependencies. */
  addTask(name: string, deps: string[] = []): this {
    if (!this.tasks.has(name)) {
      this.tasks.set(name, new Set());
    }
    for (const dep of deps) {
      this.tasks.get(name)!.add(dep);
      // Ensure dep is registered even if not explicitly added
      if (!this.tasks.has(dep)) {
        this.tasks.set(dep, new Set());
      }
    }
    return this;
  }

  /**
   * Detect cycles using DFS. Returns array of cycle paths found,
   * or empty array if the graph is acyclic.
   */
  detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): void => {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        cycles.push(path.slice(cycleStart).concat(node));
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      stack.add(node);
      path.push(node);

      for (const dep of this.tasks.get(node) ?? []) {
        dfs(dep);
      }

      path.pop();
      stack.delete(node);
    };

    for (const task of this.tasks.keys()) {
      if (!visited.has(task)) {
        dfs(task);
      }
    }

    return cycles;
  }

  /**
   * Topological sort (Kahn's algorithm).
   * Returns tasks in a valid serial execution order.
   * Throws if cycles exist.
   */
  resolve(): string[] {
    const cycles = this.detectCycles();
    if (cycles.length > 0) {
      const cycleStr = cycles.map((c) => c.join(" -> ")).join("; ");
      throw new Error(`Dependency cycle(s) detected: ${cycleStr}`);
    }

    // Build in-degree map
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, Set<string>>();

    for (const [task] of this.tasks) {
      if (!inDegree.has(task)) inDegree.set(task, 0);
      if (!dependents.has(task)) dependents.set(task, new Set());
    }

    for (const [task, deps] of this.tasks) {
      for (const dep of deps) {
        inDegree.set(task, (inDegree.get(task) ?? 0) + 1);
        dependents.get(dep)!.add(task);
      }
    }

    const queue = [...inDegree.entries()]
      .filter(([, deg]) => deg === 0)
      .map(([t]) => t)
      .sort(); // deterministic order

    const order: string[] = [];

    while (queue.length > 0) {
      const task = queue.shift()!;
      order.push(task);

      const next = [...(dependents.get(task) ?? [])].sort();
      for (const dep of next) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    return order;
  }

  /**
   * Groups tasks into parallel execution waves.
   * All tasks within a group can run concurrently;
   * each group must complete before the next starts.
   */
  getParallelGroups(): string[][] {
    const order = this.resolve(); // throws on cycles
    const rank = new Map<string, number>();

    for (const task of order) {
      let maxDepRank = -1;
      for (const dep of this.tasks.get(task) ?? []) {
        maxDepRank = Math.max(maxDepRank, rank.get(dep) ?? 0);
      }
      rank.set(task, maxDepRank + 1);
    }

    const groups: string[][] = [];
    for (const [task, r] of rank) {
      if (!groups[r]) groups[r] = [];
      groups[r].push(task);
    }

    // Sort within each group for determinism
    return groups.map((g) => g.sort());
  }
}
