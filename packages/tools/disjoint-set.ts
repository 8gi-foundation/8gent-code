/**
 * Disjoint Set Union (Union-Find) data structure with path compression and union by rank.
 */
export class DisjointSet {
  private parent: number[];
  private rank: number[];
  private count: number;

  /**
   * Creates a new DisjointSet instance.
   * @param size - The number of elements in the set.
   */
  constructor(size: number) {
    this.parent = Array(size).fill(0).map((_, i) => i);
    this.rank = Array(size).fill(0);
    this.count = size;
  }

  /**
   * Finds the root of the element with path compression.
   * @param x - The element to find the root of.
   * @returns The root of the element.
   */
  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  /**
   * Unites the sets containing elements a and b.
   * @param a - First element.
   * @param b - Second element.
   */
  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    if (this.rank[rootA] < this.rank[rootB]) {
      this.parent[rootA] = rootB;
    } else {
      this.parent[rootB] = rootA;
      if (this.rank[rootA] === this.rank[rootB]) {
        this.rank[rootA]++;
      }
    }
    this.count--;
  }

  /**
   * Checks if elements a and b are in the same component.
   * @param a - First element.
   * @param b - Second element.
   * @returns True if in the same component, false otherwise.
   */
  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }

  /**
   * Returns the number of components in the set.
   * @returns The current number of components.
   */
  componentCount(): number {
    return this.count;
  }
}