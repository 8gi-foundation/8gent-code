/**
 * Segment tree for range sum queries and point updates.
 */
export class SegmentTree {
  private tree: number[];
  private n: number;
  private size: number;

  /**
   * Constructs a segment tree from an array.
   * @param arr - The input array.
   */
  constructor(arr: number[]) {
    this.n = arr.length;
    this.size = 1;
    while (this.size < this.n) {
      this.size <<= 1;
    }
    this.tree = new Array(2 * this.size).fill(0);
    for (let i = 0; i < this.n; i++) {
      this.tree[this.size + i] = arr[i];
    }
    for (let i = this.size - 1; i > 0; i--) {
      this.tree[i] = this.tree[2 * i] + this.tree[2 * i + 1];
    }
  }

  /**
   * Queries the sum of the range [l, r].
   * @param l - Left index (inclusive).
   * @param r - Right index (inclusive).
   * @returns The sum of the range.
   */
  query(l: number, r: number): number {
    return this.queryHelper(1, 0, this.size - 1, l, r);
  }

  private queryHelper(node: number, nodeLeft: number, nodeRight: number, l: number, r: number): number {
    if (nodeRight < l || nodeLeft > r) {
      return 0;
    }
    if (l <= nodeLeft && nodeRight <= r) {
      return this.tree[node];
    }
    const mid = Math.floor((nodeLeft + nodeRight) / 2);
    return this.queryHelper(2 * node, nodeLeft, mid, l, r) + this.queryHelper(2 * node + 1, mid + 1, nodeRight, l, r);
  }

  /**
   * Updates the value at the specified index.
   * @param i - Index to update.
   * @param value - New value.
   */
  update(i: number, value: number): void {
    i += this.size;
    this.tree[i] = value;
    i >>= 1;
    while (i >= 1) {
      this.tree[i] = this.tree[2 * i] + this.tree[2 * i + 1];
      i >>= 1;
    }
  }
}