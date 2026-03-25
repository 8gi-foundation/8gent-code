/**
 * IntervalTree - efficient range overlap queries using an augmented BST.
 * Supports insert, remove, point queries, and overlap queries in O(log n) avg.
 */

export interface Interval<T = unknown> {
  low: number;
  high: number;
  data?: T;
}

interface Node<T> {
  interval: Interval<T>;
  maxHigh: number;
  left: Node<T> | null;
  right: Node<T> | null;
}

export class IntervalTree<T = unknown> {
  private root: Node<T> | null = null;
  private _size = 0;

  get size(): number {
    return this._size;
  }

  insert(interval: Interval<T>): void {
    if (interval.low > interval.high) {
      throw new Error(`Invalid interval: low (${interval.low}) > high (${interval.high})`);
    }
    this.root = this._insert(this.root, interval);
    this._size++;
  }

  private _insert(node: Node<T> | null, interval: Interval<T>): Node<T> {
    if (node === null) {
      return { interval, maxHigh: interval.high, left: null, right: null };
    }
    if (interval.low < node.interval.low) {
      node.left = this._insert(node.left, interval);
    } else {
      node.right = this._insert(node.right, interval);
    }
    node.maxHigh = Math.max(node.maxHigh, interval.high);
    return node;
  }

  remove(interval: Interval<T>): boolean {
    const before = this._size;
    this.root = this._remove(this.root, interval);
    return this._size < before;
  }

  private _remove(node: Node<T> | null, target: Interval<T>): Node<T> | null {
    if (node === null) return null;
    if (target.low < node.interval.low) {
      node.left = this._remove(node.left, target);
    } else if (target.low > node.interval.low) {
      node.right = this._remove(node.right, target);
    } else if (target.high === node.interval.high && target.data === node.interval.data) {
      this._size--;
      if (node.left === null) return node.right;
      if (node.right === null) return node.left;
      let successor = node.right;
      while (successor.left !== null) successor = successor.left;
      node.interval = successor.interval;
      node.right = this._remove(node.right, successor.interval);
    } else {
      node.right = this._remove(node.right, target);
    }
    node.maxHigh = this._computeMax(node);
    return node;
  }

  private _computeMax(node: Node<T>): number {
    let max = node.interval.high;
    if (node.left !== null) max = Math.max(max, node.left.maxHigh);
    if (node.right !== null) max = Math.max(max, node.right.maxHigh);
    return max;
  }

  /** Returns all intervals that overlap [low, high] (inclusive). */
  queryOverlap(low: number, high: number): Interval<T>[] {
    const results: Interval<T>[] = [];
    this._queryOverlap(this.root, low, high, results);
    return results;
  }

  private _queryOverlap(node: Node<T> | null, low: number, high: number, results: Interval<T>[]): void {
    if (node === null) return;
    if (node.maxHigh < low) return;
    this._queryOverlap(node.left, low, high, results);
    if (node.interval.low <= high && node.interval.high >= low) {
      results.push(node.interval);
    }
    if (node.interval.low <= high) {
      this._queryOverlap(node.right, low, high, results);
    }
  }

  /** Returns all intervals that contain the given point. */
  queryPoint(point: number): Interval<T>[] {
    return this.queryOverlap(point, point);
  }

  /** Returns true if any interval overlaps [low, high]. */
  hasOverlap(low: number, high: number): boolean {
    return this._hasOverlap(this.root, low, high);
  }

  private _hasOverlap(node: Node<T> | null, low: number, high: number): boolean {
    if (node === null) return false;
    if (node.maxHigh < low) return false;
    if (node.interval.low <= high && node.interval.high >= low) return true;
    if (this._hasOverlap(node.left, low, high)) return true;
    if (node.interval.low > high) return false;
    return this._hasOverlap(node.right, low, high);
  }

  /** Returns all stored intervals (in-order traversal). */
  toArray(): Interval<T>[] {
    const results: Interval<T>[] = [];
    this._inorder(this.root, results);
    return results;
  }

  private _inorder(node: Node<T> | null, results: Interval<T>[]): void {
    if (node === null) return;
    this._inorder(node.left, results);
    results.push(node.interval);
    this._inorder(node.right, results);
  }

  clear(): void {
    this.root = null;
    this._size = 0;
  }
}
