/**
 * RingBuffer<T> - fixed-capacity circular buffer that overwrites the oldest
 * entry when full. Useful for bounded event/log storage in agent loops.
 * O(1) push and peek, O(n) drain and iteration.
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _size = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new RangeError("RingBuffer capacity must be >= 1");
    this.buf = new Array(capacity);
  }

  get size(): number { return this._size; }
  get isEmpty(): boolean { return this._size === 0; }
  get isFull(): boolean { return this._size === this.capacity; }

  /** Push item. If full, overwrites oldest and returns the evicted item. */
  push(item: T): T | undefined {
    let evicted: T | undefined;
    if (this.isFull) {
      evicted = this.buf[this.head] as T;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this._size++;
    }
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    return evicted;
  }

  /** Oldest item without removal, or undefined when empty. */
  peek(): T | undefined {
    return this.isEmpty ? undefined : (this.buf[this.head] as T);
  }

  /** Newest item without removal, or undefined when empty. */
  peekLast(): T | undefined {
    if (this.isEmpty) return undefined;
    return this.buf[(this.tail - 1 + this.capacity) % this.capacity] as T;
  }

  /** Remove and return oldest item, or undefined when empty. */
  shift(): T | undefined {
    if (this.isEmpty) return undefined;
    const item = this.buf[this.head] as T;
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._size--;
    return item;
  }

  /** Remove and return all items in insertion order, emptying the buffer. */
  drain(): T[] {
    const result: T[] = [];
    while (!this.isEmpty) result.push(this.shift() as T);
    return result;
  }

  /** Snapshot of all items in insertion order (non-destructive). */
  toArray(): T[] {
    const result: T[] = [];
    for (const item of this) result.push(item);
    return result;
  }

  /** Empty the buffer without resizing. */
  clear(): void {
    this.buf.fill(undefined);
    this.head = this.tail = this._size = 0;
  }

  /** Iterate oldest-first. */
  [Symbol.iterator](): Iterator<T> {
    let count = 0, index = this.head;
    const { _size: size, buf, capacity } = this;
    return {
      next(): IteratorResult<T> {
        if (count >= size) return { value: undefined as unknown as T, done: true };
        const value = buf[index] as T;
        index = (index + 1) % capacity;
        count++;
        return { value, done: false };
      },
    };
  }
}
