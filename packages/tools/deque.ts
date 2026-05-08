/**
 * Double-ended queue (deque) backed by a ring buffer.
 * All push/pop/peek operations are O(1) amortized.
 */

const DEFAULT_CAPACITY = 16;

export class Deque<T> {
  private buffer: (T | undefined)[];
  private head: number;
  private tail: number;
  private count: number;
  private capacity: number;

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(initialCapacity, 4);
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /** Number of elements in the deque. */
  get size(): number {
    return this.count;
  }

  /** True if no elements are present. */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /** Add an element to the front. O(1) amortized. */
  pushFront(value: T): void {
    if (this.count === this.capacity) this.grow();
    this.head = (this.head - 1 + this.capacity) % this.capacity;
    this.buffer[this.head] = value;
    this.count++;
  }

  /** Add an element to the back. O(1) amortized. */
  pushBack(value: T): void {
    if (this.count === this.capacity) this.grow();
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
  }

  /** Remove and return the front element. Returns undefined if empty. */
  popFront(): T | undefined {
    if (this.count === 0) return undefined;
    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return value;
  }

  /** Remove and return the back element. Returns undefined if empty. */
  popBack(): T | undefined {
    if (this.count === 0) return undefined;
    this.tail = (this.tail - 1 + this.capacity) % this.capacity;
    const value = this.buffer[this.tail];
    this.buffer[this.tail] = undefined;
    this.count--;
    return value;
  }

  /** Return the front element without removing it. Returns undefined if empty. */
  peekFront(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buffer[this.head];
  }

  /** Return the back element without removing it. Returns undefined if empty. */
  peekBack(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.tail - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  /** Return all elements as an array from front to back. O(n). */
  toArray(): T[] {
    const result: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.buffer[(this.head + i) % this.capacity] as T;
    }
    return result;
  }

  /** Remove all elements and reset the buffer. */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /** Iterate front to back. */
  [Symbol.iterator](): Iterator<T> {
    let index = 0;
    const count = this.count;
    const buffer = this.buffer;
    const head = this.head;
    const capacity = this.capacity;
    return {
      next(): IteratorResult<T> {
        if (index < count) {
          const value = buffer[(head + index) % capacity] as T;
          index++;
          return { value, done: false };
        }
        return { value: undefined as unknown as T, done: true };
      },
    };
  }

  /** Double capacity and rehash when the buffer is full. */
  private grow(): void {
    const newCapacity = this.capacity * 2;
    const newBuffer: (T | undefined)[] = new Array(newCapacity);
    for (let i = 0; i < this.count; i++) {
      newBuffer[i] = this.buffer[(this.head + i) % this.capacity];
    }
    this.buffer = newBuffer;
    this.head = 0;
    this.tail = this.count;
    this.capacity = newCapacity;
  }
}
