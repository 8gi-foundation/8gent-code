/**
 * CompactSet - memory-efficient set for small integer domains using bit arrays.
 *
 * Backed by a Uint32Array where each bit represents membership of an integer.
 * Suitable for integers in range [0, capacity). Significantly more memory-efficient
 * than a native Set<number> for dense integer domains.
 *
 * Example: capacity=1024 uses 128 bytes (vs ~50KB for a native Set).
 */
export class CompactSet {
  private readonly bits: Uint32Array;
  private readonly capacity: number;
  private _size: number;

  /** @param capacity - maximum integer value (exclusive) this set can hold */
  constructor(capacity: number) {
    if (capacity < 0 || !Number.isInteger(capacity)) {
      throw new RangeError(`capacity must be a non-negative integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.bits = new Uint32Array(Math.ceil(capacity / 32));
    this._size = 0;
  }

  private assertInRange(value: number): void {
    if (value < 0 || value >= this.capacity || !Number.isInteger(value)) {
      throw new RangeError(`value ${value} is out of range [0, ${this.capacity})`);
    }
  }

  /** Add an integer to the set. Returns true if it was newly added. */
  add(value: number): boolean {
    this.assertInRange(value);
    const wordIdx = value >>> 5;       // value / 32
    const bitMask = 1 << (value & 31); // value % 32
    if (this.bits[wordIdx] & bitMask) return false;
    this.bits[wordIdx] |= bitMask;
    this._size++;
    return true;
  }

  /** Returns true if the integer is in the set. */
  has(value: number): boolean {
    if (value < 0 || value >= this.capacity || !Number.isInteger(value)) return false;
    const wordIdx = value >>> 5;
    const bitMask = 1 << (value & 31);
    return (this.bits[wordIdx] & bitMask) !== 0;
  }

  /** Remove an integer from the set. Returns true if it was present. */
  delete(value: number): boolean {
    if (value < 0 || value >= this.capacity || !Number.isInteger(value)) return false;
    const wordIdx = value >>> 5;
    const bitMask = 1 << (value & 31);
    if (!(this.bits[wordIdx] & bitMask)) return false;
    this.bits[wordIdx] &= ~bitMask;
    this._size--;
    return true;
  }

  /** Number of integers currently in the set. */
  get size(): number {
    return this._size;
  }

  /** Clear all entries from the set. */
  clear(): void {
    this.bits.fill(0);
    this._size = 0;
  }

  /** Return all members as a sorted array. */
  toArray(): number[] {
    const result: number[] = [];
    for (let w = 0; w < this.bits.length; w++) {
      let word = this.bits[w];
      while (word !== 0) {
        const bit = word & (-word); // lowest set bit
        const pos = (w * 32) + Math.log2(bit) | 0;
        if (pos < this.capacity) result.push(pos);
        word &= word - 1; // clear lowest set bit
      }
    }
    return result;
  }

  /** Return a new set containing all members of this set AND other. */
  union(other: CompactSet): CompactSet {
    const cap = Math.max(this.capacity, other.capacity);
    const result = new CompactSet(cap);
    const len = Math.min(this.bits.length, other.bits.length);
    for (let i = 0; i < len; i++) result.bits[i] = this.bits[i] | other.bits[i];
    for (let i = len; i < this.bits.length; i++) result.bits[i] = this.bits[i];
    for (let i = len; i < other.bits.length; i++) result.bits[i] = other.bits[i];
    result._size = popcount(result.bits);
    return result;
  }

  /** Return a new set containing only members present in both sets. */
  intersection(other: CompactSet): CompactSet {
    const cap = Math.min(this.capacity, other.capacity);
    const result = new CompactSet(cap);
    const len = result.bits.length;
    for (let i = 0; i < len; i++) result.bits[i] = this.bits[i] & other.bits[i];
    result._size = popcount(result.bits);
    return result;
  }

  /** Return a new set with members in this set that are NOT in other. */
  difference(other: CompactSet): CompactSet {
    const result = new CompactSet(this.capacity);
    const len = Math.min(this.bits.length, other.bits.length);
    for (let i = 0; i < len; i++) result.bits[i] = this.bits[i] & ~other.bits[i];
    for (let i = len; i < this.bits.length; i++) result.bits[i] = this.bits[i];
    result._size = popcount(result.bits);
    return result;
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this.toArray()[Symbol.iterator]();
  }
}

/** Count total set bits across all words. */
function popcount(arr: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    let w = arr[i];
    w = w - ((w >>> 1) & 0x55555555);
    w = (w & 0x33333333) + ((w >>> 2) & 0x33333333);
    count += (((w + (w >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}
