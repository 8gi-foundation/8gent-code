/**
 * GraphBuilder - fluent API for building directed and undirected weighted graphs.
 *
 * Usage:
 *   const g = GraphBuilder.directed().addNode("a").addNode("b").addEdge("a", "b", 1.5).build();
 *   const u = GraphBuilder.undirected().addNode("x").addNode("y").addEdge("x", "y").build();
 */

export interface NodeData {
  [key: string]: unknown;
}

export interface Edge {
  from: string;
  to: string;
  weight?: number;
}

export interface Graph {
  directed: boolean;
  nodes: Map<string, NodeData>;
  edges: Edge[];
  neighbors(id: string): string[];
  degree(id: string): number;
}

class BuiltGraph implements Graph {
  constructor(
    public readonly directed: boolean,
    public readonly nodes: Map<string, NodeData>,
    public readonly edges: Edge[]
  ) {}

  neighbors(id: string): string[] {
    if (!this.nodes.has(id)) return [];
    const result: string[] = [];
    for (const edge of this.edges) {
      if (edge.from === id) result.push(edge.to);
      if (!this.directed && edge.to === id) result.push(edge.from);
    }
    return [...new Set(result)];
  }

  degree(id: string): number {
    if (!this.nodes.has(id)) return 0;
    if (this.directed) {
      return this.edges.filter((e) => e.from === id || e.to === id).length;
    }
    let count = 0;
    for (const edge of this.edges) {
      if (edge.from === id || edge.to === id) count++;
      // Self-loops count twice in undirected graphs
      if (edge.from === id && edge.to === id) count++;
    }
    return count;
  }
}

export class GraphBuilder {
  private _directed: boolean;
  private _nodes: Map<string, NodeData> = new Map();
  private _edges: Edge[] = [];

  private constructor(directed: boolean) {
    this._directed = directed;
  }

  /** Create a directed graph builder. */
  static directed(): GraphBuilder {
    return new GraphBuilder(true);
  }

  /** Create an undirected graph builder. */
  static undirected(): GraphBuilder {
    return new GraphBuilder(false);
  }

  /** Add a node with optional metadata. No-op if the node already exists. */
  addNode(id: string, data: NodeData = {}): this {
    if (!this._nodes.has(id)) {
      this._nodes.set(id, data);
    }
    return this;
  }

  /**
   * Add an edge between two nodes with an optional weight.
   * Auto-creates nodes if they do not exist.
   */
  addEdge(from: string, to: string, weight?: number): this {
    this.addNode(from);
    this.addNode(to);
    this._edges.push({ from, to, weight });
    return this;
  }

  /** Remove a node and all edges connected to it. */
  removeNode(id: string): this {
    this._nodes.delete(id);
    this._edges = this._edges.filter((e) => e.from !== id && e.to !== id);
    return this;
  }

  /** Remove a matching edge. For undirected graphs, also removes the reverse direction. */
  removeEdge(from: string, to: string): this {
    this._edges = this._edges.filter((e) => {
      if (e.from === from && e.to === to) return false;
      if (!this._directed && e.from === to && e.to === from) return false;
      return true;
    });
    return this;
  }

  /** Get current neighbors of a node (convenience wrapper). */
  neighbors(id: string): string[] {
    return this.build().neighbors(id);
  }

  /** Get current degree of a node (convenience wrapper). */
  degree(id: string): number {
    return this.build().degree(id);
  }

  /** Finalise and return an immutable Graph snapshot. */
  build(): Graph {
    return new BuiltGraph(
      this._directed,
      new Map(this._nodes),
      [...this._edges]
    );
  }
}
