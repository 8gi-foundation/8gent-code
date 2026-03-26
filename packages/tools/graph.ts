/**
 * A graph data structure supporting directed and undirected graphs.
 * @template T The type of nodes in the graph.
 */
export class Graph<T> {
  private adjacencyMap: Map<T, Set<T>>;
  private isDirected: boolean;

  /**
   * Constructs a new graph.
   * @param isDirected Whether the graph is directed (default: true).
   */
  constructor(isDirected: boolean = true) {
    this.adjacencyMap = new Map();
    this.isDirected = isDirected;
  }

  /**
   * Adds a node to the graph.
   * @param node The node to add.
   */
  addNode(node: T): void {
    if (!this.adjacencyMap.has(node)) {
      this.adjacencyMap.set(node, new Set<T>());
    }
  }

  /**
   * Adds an edge between two nodes.
   * @param from The source node.
   * @param to The target node.
   */
  addEdge(from: T, to: T): void {
    this.addNode(from);
    this.addNode(to);
    this.adjacencyMap.get(from)!.add(to);
    if (!this.isDirected) {
      this.adjacencyMap.get(to)!.add(from);
    }
  }

  /**
   * Removes a node from the graph.
   * @param node The node to remove.
   */
  removeNode(node: T): void {
    if (this.adjacencyMap.has(node)) {
      this.adjacencyMap.delete(node);
      for (const [key, value] of this.adjacencyMap.entries()) {
        value.delete(node);
      }
    }
  }

  /**
   * Removes an edge between two nodes.
   * @param from The source node.
   * @param to The target node.
   */
  removeEdge(from: T, to: T): void {
    if (this.adjacencyMap.has(from)) {
      this.adjacencyMap.get(from)!.delete(to);
      if (!this.isDirected && this.adjacencyMap.has(to)) {
        this.adjacencyMap.get(to)!.delete(from);
      }
    }
  }

  /**
   * Returns the adjacent nodes of a given node.
   * @param node The node to check.
   * @returns A set of adjacent nodes.
   */
  neighbors(node: T): Set<T> {
    return this.adjacencyMap.get(node) || new Set<T>();
  }

  /**
   * Performs a breadth-first traversal starting from a node.
   * @param from The starting node.
   * @returns An array of visited nodes in BFS order.
   */
  bfs(from: T): T[] {
    const visited: T[] = [];
    const queue: T[] = [from];
    const visitedSet = new Set<T>([from]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      visited.push(current);
      for (const neighbor of this.neighbors(current)) {
        if (!visitedSet.has(neighbor)) {
          visitedSet.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return visited;
  }

  /**
   * Performs a depth-first traversal starting from a node.
   * @param from The starting node.
   * @returns An array of visited nodes in DFS order.
   */
  dfs(from: T): T[] {
    const visited: T[] = [];
    const stack: T[] = [from];
    const visitedSet = new Set<T>([from]);

    while (stack.length > 0) {
      const current = stack.pop()!;
      visited.push(current);
      for (const neighbor of this.neighbors(current)) {
        if (!visitedSet.has(neighbor)) {
          visitedSet.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    return visited;
  }

  /**
   * Checks if a path exists from one node to another.
   * @param from The starting node.
   * @param to The target node.
   * @returns True if a path exists, false otherwise.
   */
  hasPath(from: T, to: T): boolean {
    const visited = new Set<T>([from]);
    const queue: T[] = [from];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === to) {
        return true;
      }
      for (const neighbor of this.neighbors(current)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return false;
  }
}