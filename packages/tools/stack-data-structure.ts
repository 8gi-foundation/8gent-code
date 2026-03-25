/**
 * Generic stack with configurable capacity, peek, contains, and full iterator support.
 * O(1) push/pop/peek. Throws on overflow/underflow by default.
 */

export class Stack<T> implements Iterable<T> {
  private items: T[];
  private readonly maxSize: number;

  /**
   * @param maxSize - Maximum number of elements. Default: Infinity (unbounded).
   */
  constructor(maxSize: number = Infinity) {
    if (maxSize <= 0) throw new RangeError("maxSize must be greater than 0");
    this.items = [];
    this.maxSize = maxSize;
  }

  /** Number of elements currently in the stack. */
  get size(): number {
    return this.items.length;
  }

  /** Configured maximum capacity. */
  get capacity(): number {
    return this.maxSize;
  }

  /** True when the stack has no elements. */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** True when the stack has reached maxSize. */
  isFull(): boolean {
    return this.items.length >= this.maxSize;
  }

  /**
   * Push an element onto the top of the stack.
   * @throws RangeError if the stack is at capacity.
   */
  push(item: T): this {
    if (this.isFull()) {
      throw new RangeError(
        `Stack is full (capacity: ${this.maxSize}). Cannot push.`
      );
    }
    this.items.push(item);
    return this;
  }

  /**
   * Remove and return the top element.
   * @throws RangeError if the stack is empty.
   */
  pop(): T {
    if (this.isEmpty()) {
      throw new RangeError("Stack is empty. Cannot pop.");
    }
    return this.items.pop() as T;
  }

  /**
   * Return the top element without removing it.
   * @throws RangeError if the stack is empty.
   */
  peek(): T {
    if (this.isEmpty()) {
      throw new RangeError("Stack is empty. Cannot peek.");
    }
    return this.items[this.items.length - 1] as T;
  }

  /**
   * Return the top element or undefined if empty (safe variant of peek).
   */
  peekOrUndefined(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** True if item exists anywhere in the stack (uses strict equality). */
  contains(item: T): boolean {
    return this.items.includes(item);
  }

  /** Remove all elements from the stack. */
  clear(): void {
    this.items = [];
  }

  /**
   * Return a shallow copy of the stack contents as an array.
   * Index 0 = bottom, last index = top.
   */
  toArray(): T[] {
    return [...this.items];
  }

  /**
   * Iterate top-to-bottom (LIFO order).
   */
  [Symbol.iterator](): Iterator<T> {
    let index = this.items.length - 1;
    const items = this.items;
    return {
      next(): IteratorResult<T> {
        if (index >= 0) {
          return { value: items[index--] as T, done: false };
        }
        return { value: undefined as unknown as T, done: true };
      },
    };
  }

  /** String representation for debugging. */
  toString(): string {
    const top = this.isEmpty() ? "empty" : String(this.peek());
    return `Stack(size=${this.size}, capacity=${this.maxSize === Infinity ? "inf" : this.maxSize}, top=${top})`;
  }
}
