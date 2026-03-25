/**
 * BitmapIndex - fast set operations on categorical data
 *
 * Uses 32-bit integer arrays as backing storage. Each bit position maps to an
 * item ID. Supports AND (intersection), OR (union), NOT (complement), XOR
 * (symmetric difference), cardinality, and iteration over set positions.
 */

const BITS = 32;

function wordIndex(pos: number): number {
  return Math.floor(pos / BITS);
}

function bitMask(pos: number): number {
  return 1 << (pos % BITS);
}

export class BitmapIndex {
  private words: Int32Array;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.words = new Int32Array(Math.ceil(capacity / BITS));
  }

  private static fromWords(words: Int32Array, capacity: number): BitmapIndex {
    const b = new BitmapIndex(capacity);
    b.words.set(words);
    return b;
  }

  static fromArray(ids: number[], capacity?: number): BitmapIndex {
    const cap = capacity ?? (ids.length > 0 ? Math.max(...ids) + 1 : 0);
    const b = new BitmapIndex(cap);
    for (const id of ids) {
      b.set(id);
    }
    return b;
  }

  set(pos: number): this {
    if (pos < 0 || pos >= this.capacity) throw new RangeError(`pos ${pos} out of range [0, ${this.capacity})`);
    this.words[wordIndex(pos)] |= bitMask(pos);
    return this;
  }

  unset(pos: number): this {
    if (pos < 0 || pos >= this.capacity) throw new RangeError(`pos ${pos} out of range [0, ${this.capacity})`);
    this.words[wordIndex(pos)] &= ~bitMask(pos);
    return this;
  }

  has(pos: number): boolean {
    if (pos < 0 || pos >= this.capacity) return false;
    return (this.words[wordIndex(pos)] & bitMask(pos)) !== 0;
  }

  and(other: BitmapIndex): BitmapIndex {
    const len = Math.min(this.words.length, other.words.length);
    const result = new Int32Array(this.words.length);
    for (let i = 0; i < len; i++) result[i] = this.words[i] & other.words[i];
    return BitmapIndex.fromWords(result, this.capacity);
  }

  or(other: BitmapIndex): BitmapIndex {
    const maxLen = Math.max(this.words.length, other.words.length);
    const result = new Int32Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      result[i] = (this.words[i] ?? 0) | (other.words[i] ?? 0);
    }
    const cap = Math.max(this.capacity, other.capacity);
    return BitmapIndex.fromWords(result, cap);
  }

  not(): BitmapIndex {
    const result = new Int32Array(this.words.length);
    for (let i = 0; i < this.words.length; i++) result[i] = ~this.words[i];
    const tail = this.capacity % BITS;
    if (tail !== 0) result[result.length - 1] &= (1 << tail) - 1;
    return BitmapIndex.fromWords(result, this.capacity);
  }

  xor(other: BitmapIndex): BitmapIndex {
    const maxLen = Math.max(this.words.length, other.words.length);
    const result = new Int32Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      result[i] = (this.words[i] ?? 0) ^ (other.words[i] ?? 0);
    }
    const cap = Math.max(this.capacity, other.capacity);
    return BitmapIndex.fromWords(result, cap);
  }

  count(): number {
    let n = 0;
    for (const w of this.words) {
      let v = w >>> 0;
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return n;
  }

  *positions(): Generator<number> {
    for (let wi = 0; wi < this.words.length; wi++) {
      let w = this.words[wi] >>> 0;
      while (w !== 0) {
        const bit = w & (-w);
        const pos = wi * BITS + Math.log2(bit) | 0;
        if (pos < this.capacity) yield pos;
        w ^= bit;
      }
    }
  }

  toArray(): number[] {
    return [...this.positions()];
  }
}
