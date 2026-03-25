/**
 * Typed circular buffer (ring buffer) with configurable overflow strategy.
 *
 * Overflow strategies:
 *   - "overwrite"  (default) - overwrite the oldest entry when full
 *   - "throw"      - throw RangeError when full
 */
export type OverflowStrategy = "overwrite" | "throw";

export interface CircularBufferOptions {
  overflow?: OverflowStrategy;
}

export class CircularBuffer<T> implements Iterable<T> {
  private readonly _buf: (T | undefined)[];
  private readonly _capacity: number;
  private readonly _overflow: OverflowStrategy;

  /** Index where the next write goes */
  private _head = 0;
  /** Index where the next read comes from */
  private _tail = 0;
  private _size = 0;

  constructor(capacity: number, options: CircularBufferOptions = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this._capacity = capacity;
    this._overflow = options.overflow ?? "overwrite";
    this._buf = new Array(capacity);
  }

  /** Maximum number of items the buffer can hold. */
  get capacity(): number {
    return this._capacity;
  }

  /** Number of items currently in the buffer. */
  get size(): number {
    return this._size;
  }

  /** True when no items are present. */
  isEmpty(): boolean {
    return this._size === 0;
  }

  /** True when size equals capacity. */
  isFull(): boolean {
    return this._size === this._capacity;
  }

  /**
   * Add an item to the buffer.
   * If full and overflow is "throw", throws RangeError.
   * If full and overflow is "overwrite", the oldest item is silently dropped.
   */
  push(item: T): void {
    if (this.isFull()) {
      if (this._overflow === "throw") {
        throw new RangeError("CircularBuffer is full");
      }
      // Overwrite: advance tail to discard oldest
      this._tail = (this._tail + 1) % this._capacity;
      this._size--;
    }
    this._buf[this._head] = item;
    this._head = (this._head + 1) % this._capacity;
    this._size++;
  }

  /**
   * Remove and return the oldest item.
   * Returns undefined if the buffer is empty.
   */
  shift(): T | undefined {
    if (this.isEmpty()) return undefined;
    const item = this._buf[this._tail] as T;
    this._buf[this._tail] = undefined;
    this._tail = (this._tail + 1) % this._capacity;
    this._size--;
    return item;
  }

  /**
   * Return the oldest item without removing it.
   * Returns undefined if the buffer is empty.
   */
  peek(): T | undefined {
    if (this.isEmpty()) return undefined;
    return this._buf[this._tail] as T;
  }

  /**
   * Return all items in insertion order (oldest first) without mutating state.
   */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(this._buf[(this._tail + i) % this._capacity] as T);
    }
    return result;
  }

  /** Remove all items and reset internal pointers. */
  clear(): void {
    this._buf.fill(undefined);
    this._head = 0;
    this._tail = 0;
    this._size = 0;
  }

  /** Iterate over items from oldest to newest. */
  [Symbol.iterator](): Iterator<T> {
    let index = 0;
    const size = this._size;
    const tail = this._tail;
    const capacity = this._capacity;
    const buf = this._buf;

    return {
      next(): IteratorResult<T> {
        if (index >= size) {
          return { done: true, value: undefined as unknown as T };
        }
        const value = buf[(tail + index) % capacity] as T;
        index++;
        return { done: false, value };
      },
    };
  }
}
