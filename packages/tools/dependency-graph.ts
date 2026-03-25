/**
 * DependencyGraph - builds and queries module dependency graphs.
 *
 * Features:
 *   - add/remove nodes and directed edges
 *   - cycle detection (DFS-based)
 *   - topological sort (Kahn's algorithm)
 *   - find direct dependents / dependencies
 *   - transitive closure (all reachable nodes)
 *   - orphan detection (nodes with no edges)
 */

export interface GraphNode {
  id: string;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export class DependencyGraph {
  private nodes = new Map<string, GraphNode>();
  // adjacency: from -> Set<to>
  private adj = new Map<string, Set<string>>();
  // reverse adjacency: to -> Set<from>
  private radj = new Map<string, Set<string>>();

  addNode(id: string, meta?: Record<string, unknown>): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, meta });
      this.adj.set(id, new Set());
      this.radj.set(id, new Set());
    }
  }

  removeNode(id: string): void {
    if (!this.nodes.has(id)) return;
    for (const dep of this.adj.get(id) ?? []) this.radj.get(dep)?.delete(id);
    for (const dep of this.radj.get(id) ?? []) this.adj.get(dep)?.delete(id);
    this.nodes.delete(id);
    this.adj.delete(id);
    this.radj.delete(id);
  }

  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from)) this.addNode(from);
    if (!this.nodes.has(to)) this.addNode(to);
    this.adj.get(from)!.add(to);
    this.radj.get(to)!.add(from);
  }

  removeEdge(from: string, to: string): void {
    this.adj.get(from)?.delete(to);
    this.radj.get(to)?.delete(from);
  }

  /** Direct dependencies of node (what it depends on). */
  dependencies(id: string): string[] {
    return [...(this.adj.get(id) ?? [])];
  }

  /** Direct dependents of node (what depends on it). */
  dependents(id: string): string[] {
    return [...(this.radj.get(id) ?? [])];
  }

  /**
   * Detect cycles. Returns the first cycle found as an ordered path,
   * or null if the graph is acyclic.
   */
  detectCycle(): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.nodes.keys()) color.set(id, WHITE);

    const path: string[] = [];

    const dfs = (node: string): string[] | null => {
      color.set(node, GRAY);
      path.push(node);
      for (const next of this.adj.get(node) ?? []) {
        if (color.get(next) === GRAY) {
          const cycleStart = path.indexOf(next);
          return [...path.slice(cycleStart), next];
        }
        if (color.get(next) === WHITE) {
          const result = dfs(next);
          if (result) return result;
        }
      }
      path.pop();
      color.set(node, BLACK);
      return null;
    };

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) {
        const cycle = dfs(id);
        if (cycle) return cycle;
      }
    }
    return null;
  }

  hasCycle(): boolean {
    return this.detectCycle() !== null;
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Throws if the graph contains a cycle.
   * Returns nodes in dependency-first order.
   */
  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const id of this.nodes.keys()) inDegree.set(id, this.radj.get(id)!.size);

    const queue = [...this.nodes.keys()].filter(id => inDegree.get(id) === 0);
    const sorted: string[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const next of this.adj.get(node) ?? []) {
        const deg = inDegree.get(next)! - 1;
        inDegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }

    if (sorted.length !== this.nodes.size) {
      throw new Error("Graph has a cycle - topological sort is not possible");
    }
    return sorted;
  }

  /** All nodes transitively reachable from id (following dependency edges). */
  transitiveDependencies(id: string): string[] {
    return this.reachable(id, this.adj);
  }

  /** All nodes that transitively depend on id. */
  transitiveDependents(id: string): string[] {
    return this.reachable(id, this.radj);
  }

  private reachable(start: string, graph: Map<string, Set<string>>): string[] {
    const visited = new Set<string>();
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of graph.get(node) ?? []) stack.push(next);
    }
    return [...visited];
  }

  /** Orphan nodes: no incoming or outgoing edges. */
  orphans(): string[] {
    return [...this.nodes.keys()].filter(
      id => this.adj.get(id)!.size === 0 && this.radj.get(id)!.size === 0
    );
  }

  allNodes(): string[] {
    return [...this.nodes.keys()];
  }

  allEdges(): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const [from, tos] of this.adj) {
      for (const to of tos) edges.push({ from, to });
    }
    return edges;
  }

  size(): { nodes: number; edges: number } {
    return {
      nodes: this.nodes.size,
      edges: [...this.adj.values()].reduce((s, set) => s + set.size, 0),
    };
  }
}
