/**
 * Graph class for handling adjacency list or matrix representations.
 */
export class Graph {
  private adjList: Map<number, Map<number, number>>;
  private isDirected: boolean;

  /**
   * Constructs a graph from adjacency list or matrix.
   * @param data - Adjacency list or matrix.
   * @param isDirected - Whether the graph is directed.
   */
  constructor(data: any, isDirected: boolean) {
    this.adjList = new Map();
    this.isDirected = isDirected;

    if (Array.isArray(data[0])) {
      for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < data[i].length; j++) {
          if (data[i][j] !== 0) {
            this.addUndirectedEdge(i, j, data[i][j]);
          }
        }
      }
    } else {
      for (const [u, neighbors] of Object.entries(data)) {
        for (const [v, weight] of Object.entries(neighbors)) {
          this.addDirectedEdge(parseInt(u), parseInt(v), parseInt(weight));
        }
      }
    }
  }

  private addDirectedEdge(u: number, v: number, weight: number): void {
    if (!this.adjList.has(u)) this.adjList.set(u, new Map());
    this.adjList.get(u)!.set(v, weight);
  }

  private addUndirectedEdge(u: number, v: number, weight: number): void {
    this.addDirectedEdge(u, v, weight);
    this.addDirectedEdge(v, u, weight);
  }

  getNeighbors(u: number): Map<number, number> {
    return this.adjList.get(u) || new Map();
  }

  isDirected(): boolean {
    return this.isDirected;
  }
}

/**
 * Dijkstra's algorithm for single-source shortest paths.
 * @param graph - Graph instance.
 * @param start - Starting node.
 * @returns Map of shortest distances.
 */
export function dijkstra(graph: Graph, start: number): Map<number, number> {
  const dist = new Map<number, number>();
  const pq: { node: number; dist: number }[] = [];
  const visited = new Set<number>();

  dist.set(start, 0);
  pq.push({ node: start, dist: 0 });

  while (pq.length > 0) {
    pq.sort((a, b) => a.dist - b.dist);
    const current = pq.shift()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);

    for (const [neighbor, weight] of graph.getNeighbors(current.node)) {
      const newDist = dist.get(current.node)! + weight;
      if (!dist.has(neighbor) || newDist < dist.get(neighbor)!) {
        dist.set(neighbor, newDist);
        pq.push({ node: neighbor, dist: newDist });
      }
    }
  }

  return dist;
}

/**
 * BFS traversal with order output.
 * @param graph - Graph instance.
 * @param start - Starting node.
 * @returns Traversal order.
 */
export function bfs(graph: Graph, start: number): number[] {
  const visited = new Set<number>();
  const order: number[] = [];
  const queue: number[] = [start];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    order.push(node);

    for (const neighbor of graph.getNeighbors(node).keys()) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }

  return order;
}

/**
 * DFS traversal with order output.
 * @param graph - Graph instance.
 * @param start - Starting node.
 * @returns Traversal order.
 */
export function dfs(graph: Graph, start: number): number[] {
  const visited = new Set<number>();
  const order: number[] = [];

  function recurse(node: number) {
    if (visited.has(node)) return;
    visited.add(node);
    order.push(node);

    for (const neighbor of graph.getNeighbors(node).keys()) {
      recurse(neighbor);
    }
  }

  recurse(start);
  return order;
}

/**
 * Topological sort for directed acyclic graphs.
 * @param graph - Graph instance.
 * @returns Topological order.
 */
export function topologicalSort(graph: Graph): number[] {
  if (!graph.isDirected()) throw new Error("Topological sort requires directed graph");
  const inDegree = new Map<number, number>();
  const adjList = graph.adjList;
  const queue: number[] = [];

  for (const [u, neighbors] of adjList) {
    for (const [v] of neighbors) {
      inDegree.set(v, (inDegree.get(v) || 0) + 1);
    }
  }

  for (const [u] of adjList) {
    if (!inDegree.has(u) || inDegree.get(u)! === 0) {
      queue.push(u);
    }
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);

    for (const [neighbor] of adjList.get(node) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor)! === 0) {
        queue.push(neighbor);
      }
    }
  }

  return order;
}

/**
 * Find connected components in the graph.
 * @param graph - Graph instance.
 * @returns List of components.
 */
export function connectedComponents(graph: Graph): number[][] {
  const visited = new Set<number>();
  const components: number[][] = [];

  for (const [node] of graph.adjList) {
    if (!visited.has(node)) {
      const component = bfs(graph, node);
      components.push(component);
      for (const n of component) {
        visited.add(n);
      }
    }
  }

  return components;
}

/**
 * Check for cycles in the graph.
 * @param graph - Graph instance.
 * @returns True if a cycle exists.
 */
export function hasCycle(graph: Graph): boolean {
  if (graph.isDirected()) {
    const visited = new Set<number>();
    const recursionStack = new Set<number>();

    function dfs(node: number): boolean {
      if (recursionStack.has(node)) return true;
      if (visited.has(node)) return false;

      visited.add(node);
      recursionStack.add(node);

      for (const neighbor of graph.getNeighbors(node).keys()) {
        if (dfs(neighbor)) return true;
      }

      recursionStack.delete(node);
      return false;
    }

    for (const [node] of graph.adjList) {
      if (!visited.has(node) && dfs(node)) {
        return true;
      }
    }

    return false;
  } else {
    const visited = new Set<number>();

    for (const [node] of graph.adjList) {
      if (!visited.has(node)) {
        const stack: number[] = [node];
        visited.add(node);

        while (stack.length > 0) {
          const current = stack.pop()!;
          for (const neighbor of graph.getNeighbors(current).keys()) {
            if (visited.has(neighbor)) return true;
            visited.add(neighbor);
            stack.push(neighbor);
          }
        }
      }
    }

    return false;
  }
}