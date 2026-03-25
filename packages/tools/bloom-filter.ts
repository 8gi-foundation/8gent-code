/**
 * BloomFilter - probabilistic set membership testing
 *
 * Space-efficient data structure for fast membership queries.
 * Guarantees no false negatives; false positives are configurable.
 */

export interface BloomFilterOptions {
  /** Expected number of items to insert */
  capacity: number;
  /** Target false positive probability (0-1), default 0.01 */
  falsePositiveRate?: number;
}

export interface BloomFilterState {
  bits: number[];
  hashCount: number;
  size: number;
  itemCount: number;
}

export class BloomFilter {
  private bits: Uint8Array;
  private hashCount: number;
  private size: number;
  private itemCount: number;

  constructor(options: BloomFilterOptions) {
    const fpr = options.falsePositiveRate ?? 0.01;
    this.size = BloomFilter.optimalSize(options.capacity, fpr);
    this.hashCount = BloomFilter.optimalHashCount(this.size, options.capacity);
    this.bits = new Uint8Array(Math.ceil(this.size / 8));
    this.itemCount = 0;
  }

  /** Calculate optimal bit array size given capacity and false positive rate */
  static optimalSize(capacity: number, fpr: number): number {
    return Math.ceil(-(capacity * Math.log(fpr)) / Math.LN2 ** 2);
  }

  /** Calculate optimal number of hash functions */
  static optimalHashCount(size: number, capacity: number): number {
    return Math.max(1, Math.round((size / capacity) * Math.LN2));
  }

  /** Add an item to the filter */
  add(item: string): void {
    for (const index of this.hashIndices(item)) {
      this.setBit(index);
    }
    this.itemCount++;
  }

  /** Test whether an item is probably in the set */
  has(item: string): boolean {
    for (const index of this.hashIndices(item)) {
      if (!this.getBit(index)) return false;
    }
    return true;
  }

  /** Estimated false positive rate given current item count */
  currentFalsePositiveRate(): number {
    const exponent = -(this.hashCount * this.itemCount) / this.size;
    return Math.pow(1 - Math.exp(exponent), this.hashCount);
  }

  /** Number of items added */
  get count(): number {
    return this.itemCount;
  }

  /** Serialize to plain state object (JSON-safe) */
  serialize(): BloomFilterState {
    return {
      bits: Array.from(this.bits),
      hashCount: this.hashCount,
      size: this.size,
      itemCount: this.itemCount,
    };
  }

  /** Restore from serialized state */
  static deserialize(state: BloomFilterState): BloomFilter {
    // Dummy capacity/fpr - we override internal state directly
    const filter = Object.create(BloomFilter.prototype) as BloomFilter;
    filter.size = state.size;
    filter.hashCount = state.hashCount;
    filter.bits = new Uint8Array(state.bits);
    filter.itemCount = state.itemCount;
    return filter;
  }

  // ---- internals ----

  private hashIndices(item: string): number[] {
    const h1 = this.fnv1a(item, 0x811c9dc5);
    const h2 = this.fnv1a(item, 0x01000193);
    const indices: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      indices.push(Math.abs((h1 + i * h2) % this.size));
    }
    return indices;
  }

  /** FNV-1a 32-bit with seed via XOR */
  private fnv1a(str: string, seed: number): number {
    let hash = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  private setBit(index: number): void {
    const byte = Math.floor(index / 8);
    const bit = index % 8;
    this.bits[byte] |= 1 << bit;
  }

  private getBit(index: number): boolean {
    const byte = Math.floor(index / 8);
    const bit = index % 8;
    return (this.bits[byte] & (1 << bit)) !== 0;
  }
}
