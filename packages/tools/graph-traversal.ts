/**
 * Generic Graph<T> - BFS, DFS, Dijkstra, connected components, cycle detection.
 * Self-contained. No external deps.
 */

export interface Edge<T> {
  to: T;
  weight: number;
}

export class Graph<T> {
  private adjacency: Map<T, Edge<T>[]> = new Map();
  private directed: boolean;

  constructor(directed = false) {
    this.directed = directed;
  }

  addNode(node: T): void {
    if (!this.adjacency.has(node)) {
      this.adjacency.set(node, []);
    }
  }

  addEdge(from: T, to: T, weight = 1): void {
    this.addNode(from);
    this.addNode(to);
    this.adjacency.get(from)!.push({ to, weight });
    if (!this.directed) {
      this.adjacency.get(to)!.push({ to: from, weight });
    }
  }

  nodes(): T[] {
    return Array.from(this.adjacency.keys());
  }

  neighbors(node: T): Edge<T>[] {
    return this.adjacency.get(node) ?? [];
  }

  // Breadth-first search - returns nodes in visit order from start
  bfs(start: T): T[] {
    const visited = new Set<T>();
    const order: T[] = [];
    const queue: T[] = [start];
    visited.add(start);

    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const { to } of this.neighbors(node)) {
        if (!visited.has(to)) {
          visited.add(to);
          queue.push(to);
        }
      }
    }
    return order;
  }

  // Depth-first search - returns nodes in visit order from start
  dfs(start: T): T[] {
    const visited = new Set<T>();
    const order: T[] = [];

    const visit = (node: T) => {
      visited.add(node);
      order.push(node);
      for (const { to } of this.neighbors(node)) {
        if (!visited.has(to)) visit(to);
      }
    };

    visit(start);
    return order;
  }

  // Dijkstra shortest path - returns { dist, prev } maps
  dijkstra(start: T): { dist: Map<T, number>; prev: Map<T, T | null> } {
    const dist = new Map<T, number>();
    const prev = new Map<T, T | null>();
    const unvisited = new Set<T>(this.adjacency.keys());

    for (const node of unvisited) {
      dist.set(node, Infinity);
      prev.set(node, null);
    }
    dist.set(start, 0);

    while (unvisited.size > 0) {
      // Pick unvisited node with smallest dist
      let u: T | null = null;
      let best = Infinity;
      for (const node of unvisited) {
        const d = dist.get(node)!;
        if (d < best) { best = d; u = node; }
      }
      if (u === null || best === Infinity) break;

      unvisited.delete(u);

      for (const { to, weight } of this.neighbors(u)) {
        if (!unvisited.has(to)) continue;
        const alt = dist.get(u)! + weight;
        if (alt < dist.get(to)!) {
          dist.set(to, alt);
          prev.set(to, u);
        }
      }
    }

    return { dist, prev };
  }

  // Reconstruct path from dijkstra prev map
  shortestPath(start: T, end: T): { path: T[]; cost: number } | null {
    const { dist, prev } = this.dijkstra(start);
    if (!dist.has(end) || dist.get(end) === Infinity) return null;

    const path: T[] = [];
    let cur: T | null = end;
    while (cur !== null) {
      path.unshift(cur);
      cur = prev.get(cur) ?? null;
    }
    return { path, cost: dist.get(end)! };
  }

  // Connected components - returns array of node groups
  connectedComponents(): T[][] {
    const visited = new Set<T>();
    const components: T[][] = [];

    for (const node of this.adjacency.keys()) {
      if (!visited.has(node)) {
        const component = this.bfs(node);
        component.forEach(n => visited.add(n));
        components.push(component);
      }
    }
    return components;
  }

  // Cycle detection via DFS coloring (works for directed + undirected)
  hasCycle(): boolean {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<T, number>();
    for (const node of this.adjacency.keys()) color.set(node, WHITE);

    const dfsVisit = (node: T, parent: T | null): boolean => {
      color.set(node, GRAY);
      for (const { to } of this.neighbors(node)) {
        if (this.directed) {
          if (color.get(to) === GRAY) return true;
          if (color.get(to) === WHITE && dfsVisit(to, node)) return true;
        } else {
          if (to !== parent && color.get(to) === GRAY) return true;
          if (color.get(to) === WHITE && dfsVisit(to, node)) return true;
        }
      }
      color.set(node, BLACK);
      return false;
    };

    for (const node of this.adjacency.keys()) {
      if (color.get(node) === WHITE && dfsVisit(node, null)) return true;
    }
    return false;
  }
}
