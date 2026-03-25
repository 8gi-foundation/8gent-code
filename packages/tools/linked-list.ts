/**
 * Doubly linked list with O(1) insert/remove by node reference.
 * Supports push/pop/shift/unshift, insert-at-index, find, iterate, and toArray.
 */

export interface ListNode<T> {
  value: T;
  prev: ListNode<T> | null;
  next: ListNode<T> | null;
}

function makeNode<T>(value: T): ListNode<T> {
  return { value, prev: null, next: null };
}

export class LinkedList<T> implements Iterable<T> {
  private head: ListNode<T> | null = null;
  private tail: ListNode<T> | null = null;
  private _size = 0;

  get size(): number {
    return this._size;
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  /** Append value to the end. Returns the new node. O(1). */
  push(value: T): ListNode<T> {
    const node = makeNode(value);
    if (this.tail === null) {
      this.head = this.tail = node;
    } else {
      node.prev = this.tail;
      this.tail.next = node;
      this.tail = node;
    }
    this._size++;
    return node;
  }

  /** Remove and return the last value. O(1). */
  pop(): T | undefined {
    if (this.tail === null) return undefined;
    const value = this.tail.value;
    this.removeNode(this.tail);
    return value;
  }

  /** Prepend value to the front. Returns the new node. O(1). */
  unshift(value: T): ListNode<T> {
    const node = makeNode(value);
    if (this.head === null) {
      this.head = this.tail = node;
    } else {
      node.next = this.head;
      this.head.prev = node;
      this.head = node;
    }
    this._size++;
    return node;
  }

  /** Remove and return the first value. O(1). */
  shift(): T | undefined {
    if (this.head === null) return undefined;
    const value = this.head.value;
    this.removeNode(this.head);
    return value;
  }

  /**
   * Remove a node by direct reference. O(1).
   * Caller must ensure the node belongs to this list.
   */
  removeNode(node: ListNode<T>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = node.next = null;
    this._size--;
  }

  /**
   * Insert value after an existing node. O(1).
   * Returns the new node.
   */
  insertAfter(ref: ListNode<T>, value: T): ListNode<T> {
    const node = makeNode(value);
    node.prev = ref;
    node.next = ref.next;
    if (ref.next !== null) {
      ref.next.prev = node;
    } else {
      this.tail = node;
    }
    ref.next = node;
    this._size++;
    return node;
  }

  /**
   * Insert value at a zero-based index. O(n) traversal to find position.
   * Index 0 is equivalent to unshift. Index >= size is equivalent to push.
   */
  insertAt(index: number, value: T): ListNode<T> {
    if (index <= 0) return this.unshift(value);
    if (index >= this._size) return this.push(value);
    const ref = this.nodeAt(index - 1)!;
    return this.insertAfter(ref, value);
  }

  /** Find the first node satisfying predicate. O(n). */
  find(predicate: (value: T) => boolean): ListNode<T> | null {
    let current = this.head;
    while (current !== null) {
      if (predicate(current.value)) return current;
      current = current.next;
    }
    return null;
  }

  /** Return the node at zero-based index. O(n). */
  nodeAt(index: number): ListNode<T> | null {
    if (index < 0 || index >= this._size) return null;
    let current = this.head!;
    for (let i = 0; i < index; i++) {
      current = current.next!;
    }
    return current;
  }

  /** Return value at zero-based index. O(n). */
  at(index: number): T | undefined {
    return this.nodeAt(index)?.value;
  }

  /** Snapshot the list as an array. O(n). */
  toArray(): T[] {
    const result: T[] = [];
    for (const value of this) result.push(value);
    return result;
  }

  /** Clear all nodes. O(1). */
  clear(): void {
    this.head = this.tail = null;
    this._size = 0;
  }

  [Symbol.iterator](): Iterator<T> {
    let current = this.head;
    return {
      next(): IteratorResult<T> {
        if (current === null) return { value: undefined as unknown as T, done: true };
        const value = current.value;
        current = current.next;
        return { value, done: false };
      },
    };
  }
}
