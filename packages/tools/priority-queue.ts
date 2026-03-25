/**
 * PriorityQueue<T> - binary heap implementation with configurable comparator.
 * Supports min-heap, max-heap, or any custom ordering.
 * Used for agent task scheduling and event processing pipelines.
 */

export type Comparator<T> = (a: T, b: T) => number;

/** Default min-heap comparator for numbers. */
export const minComparator: Comparator<number> = (a, b) => a - b;

/** Default max-heap comparator for numbers. */
export const maxComparator: Comparator<number> = (a, b) => b - a;

export class PriorityQueue<T> {
  private heap: T[] = [];
  private compare: Comparator<T>;

  constructor(comparator: Comparator<T>) {
    this.compare = comparator;
  }

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  poll(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();
    const top = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.sinkDown(0);
    return top;
  }

  pushPoll(item: T): T {
    if (this.heap.length > 0 && this.compare(this.heap[0], item) <= 0) {
      const top = this.heap[0];
      this.heap[0] = item;
      this.sinkDown(0);
      return top;
    }
    return item;
  }

  drain(): T[] {
    const result: T[] = [];
    while (!this.isEmpty()) result.push(this.poll()!);
    return result;
  }

  clear(): void {
    this.heap = [];
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let best = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.compare(this.heap[left], this.heap[best]) < 0) best = left;
      if (right < n && this.compare(this.heap[right], this.heap[best]) < 0) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
  }

  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
  }
}
