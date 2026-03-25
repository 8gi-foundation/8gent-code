/**
 * Directed Acyclic Graph utility.
 */
export class DAG {
  private nodes: Map<string, any>;
  private dependencies: Map<string, Set<string>>;
  private dependents: Map<string, Set<string>>;

  constructor() {
    this.nodes = new Map();
    this.dependencies = new Map();
    this.dependents = new Map();
  }

  /**
   * Add a node to the graph.
   * @param id - Unique identifier for the node.
   * @param data - Arbitrary data associated with the node.
   */
  addNode(id: string, data: any): void {
    this.nodes.set(id, data);
    this.dependencies.set(id, new Set<string>());
    this.dependents.set(id, new Set<string>());
  }

  /**
   * Add an edge from one node to another.
   * @param from - Source node ID.
   * @param to - Target node ID.
   * @throws {Error} If the nodes do not exist or a cycle is detected.
   */
  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error('Node does not exist');
    }
    if (this.hasCycle(from, to)) {
      throw new Error('Cycle detected');
    }
    this.dependencies.get(from)!.add(to);
    this.dependents.get(to)!.add(from);
  }

  /**
   * Get direct dependencies of a node.
   * @param id - Node ID.
   * @returns Array of direct dependency IDs.
   */
  dependsOn(id: string): string[] {
    return Array.from(this.dependencies.get(id) || []);
  }

  /**
   * Get nodes that directly depend on this node.
   * @param id - Node ID.
   * @returns Array of dependent node IDs.
   */
  dependedOnBy(id: string): string[] {
    return Array.from(this.dependents.get(id) || []);
  }

  /**
   * Get execution order as parallel batches.
   * @returns Array of batches, each containing nodes that can be executed in parallel.
   */
  executionOrder(): string[][] {
    const inDegree = new Map<string, number>();
    for (const node of this.nodes.keys()) {
      inDegree.set(node, 0);
    }
    for (const [node, deps] of this.dependencies.entries()) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const node of this.nodes.keys()) {
      if (inDegree.get(node) === 0) {
        queue.push(node);
      }
    }
    const result: string[][] = [];
    while (queue.length > 0) {
      const levelSize = queue.length;
      const currentLevel: string[] = [];
      for (let i = 0; i < levelSize; i++) {
        const node = queue.shift()!;
        currentLevel.push(node);
        for (const dependent of this.dependents.get(node) || []) {
          inDegree.set(dependent, inDegree.get(dependent)! - 1);
          if (inDegree.get(dependent) === 0) {
            queue.push(dependent);
          }
        }
      }
      result.push(currentLevel);
    }
    return result;
  }

  private hasCycle(from: string, to: string): boolean {
    const visited = new Set<string>();
    const stack: string[] = [to];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const dependent of this.dependents.get(node) || []) {
        if (dependent === from) return true;
        stack.push(dependent);
      }
    }
    return false;
  }
}