/**
 * DependencyGraph - builds and queries module dependency graphs.
 * Features: add/remove nodes+edges, cycle detection (DFS), topological sort
 * (Kahn), direct/transitive dependencies+dependents, orphan detection.
 */

export interface GraphNode { id: string; meta?: Record<string, unknown>; }
export interface GraphEdge { from: string; to: string; }

export class DependencyGraph {
  private nodes = new Map<string, GraphNode>();
  private adj  = new Map<string, Set<string>>();   // from -> to
  private radj = new Map<string, Set<string>>();   // to   -> from

  addNode(id: string, meta?: Record<string, unknown>): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, meta });
      this.adj.set(id, new Set());
      this.radj.set(id, new Set());
    }
  }

  removeNode(id: string): void {
    if (!this.nodes.has(id)) return;
    for (const t of this.adj.get(id)  ?? []) this.radj.get(t)?.delete(id);
    for (const f of this.radj.get(id) ?? []) this.adj.get(f)?.delete(id);
    this.nodes.delete(id); this.adj.delete(id); this.radj.delete(id);
  }

  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from)) this.addNode(from);
    if (!this.nodes.has(to))   this.addNode(to);
    this.adj.get(from)!.add(to);
    this.radj.get(to)!.add(from);
  }

  removeEdge(from: string, to: string): void {
    this.adj.get(from)?.delete(to);
    this.radj.get(to)?.delete(from);
  }

  /** Nodes this id directly depends on. */
  dependencies(id: string): string[] { return [...(this.adj.get(id) ?? [])]; }

  /** Nodes that directly depend on this id. */
  dependents(id: string): string[]   { return [...(this.radj.get(id) ?? [])]; }

  /**
   * DFS cycle detection. Returns the cycle as an ordered path, or null.
   */
  detectCycle(): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(
      [...this.nodes.keys()].map(k => [k, WHITE])
    );
    const path: string[] = [];

    const dfs = (node: string): string[] | null => {
      color.set(node, GRAY); path.push(node);
      for (const next of this.adj.get(node) ?? []) {
        if (color.get(next) === GRAY)
          return [...path.slice(path.indexOf(next)), next];
        if (color.get(next) === WHITE) { const r = dfs(next); if (r) return r; }
      }
      path.pop(); color.set(node, BLACK); return null;
    };

    for (const id of this.nodes.keys())
      if (color.get(id) === WHITE) { const c = dfs(id); if (c) return c; }
    return null;
  }

  hasCycle(): boolean { return this.detectCycle() !== null; }

  /**
   * Kahn's topological sort. Throws if the graph contains a cycle.
   * Returns nodes in dependency-first order.
   */
  topologicalSort(): string[] {
    const inDeg = new Map<string, number>(
      [...this.nodes.keys()].map(k => [k, this.radj.get(k)!.size])
    );
    const queue = [...this.nodes.keys()].filter(id => inDeg.get(id) === 0);
    const sorted: string[] = [];
    while (queue.length) {
      const node = queue.shift()!; sorted.push(node);
      for (const next of this.adj.get(node) ?? []) {
        const d = inDeg.get(next)! - 1; inDeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (sorted.length !== this.nodes.size)
      throw new Error("Graph has a cycle - topological sort not possible");
    return sorted;
  }

  /** All nodes transitively reachable following dependency edges from id. */
  transitiveDependencies(id: string): string[] { return this.reachable(id, this.adj); }

  /** All nodes that transitively depend on id. */
  transitiveDependents(id: string): string[]   { return this.reachable(id, this.radj); }

  private reachable(start: string, g: Map<string, Set<string>>): string[] {
    const visited = new Set<string>();
    const stack = [...(g.get(start) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      for (const next of g.get(n) ?? []) stack.push(next);
    }
    return [...visited];
  }

  /** Nodes with no incoming or outgoing edges - potential dead code. */
  orphans(): string[] {
    return [...this.nodes.keys()].filter(
      id => this.adj.get(id)!.size === 0 && this.radj.get(id)!.size === 0
    );
  }

  allNodes(): string[]  { return [...this.nodes.keys()]; }

  allEdges(): GraphEdge[] {
    const out: GraphEdge[] = [];
    for (const [from, tos] of this.adj) for (const to of tos) out.push({ from, to });
    return out;
  }

  size(): { nodes: number; edges: number } {
    return {
      nodes: this.nodes.size,
      edges: [...this.adj.values()].reduce((s, set) => s + set.size, 0),
    };
  }
}
