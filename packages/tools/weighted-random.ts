/**
 * WeightedPool<T> - weighted random selection from a pool of items.
 *
 * Features:
 * - Add items with numeric weights
 * - Select one item by weight (higher weight = higher probability)
 * - Select N unique items by weight (without replacement)
 * - Adjust individual item weights dynamically
 * - Normalize weights to sum to 1.0
 * - Optional seeded PRNG for reproducible selections
 */

export interface WeightedItem<T> {
  value: T;
  weight: number;
}

/** Minimal seeded PRNG (mulberry32). Seed 0 is replaced with 1. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WeightedPool<T> {
  private items: WeightedItem<T>[] = [];
  rand: () => number;

  /**
   * @param seed - Optional integer seed for reproducibility. Omit for Math.random.
   */
  constructor(seed?: number) {
    this.rand = seed !== undefined ? makePrng(seed) : Math.random;
  }

  /** Add an item to the pool with a given weight. Weight must be > 0. */
  add(value: T, weight: number): this {
    if (weight <= 0) throw new Error(`Weight must be > 0, got ${weight}`);
    const existing = this.items.find((i) => i.value === value);
    if (existing) {
      existing.weight += weight;
    } else {
      this.items.push({ value, weight });
    }
    return this;
  }

  /** Remove an item from the pool. No-op if not found. */
  remove(value: T): this {
    this.items = this.items.filter((i) => i.value !== value);
    return this;
  }

  /** Set (replace) the weight of an existing item. Throws if item not found. */
  setWeight(value: T, weight: number): this {
    if (weight <= 0) throw new Error(`Weight must be > 0, got ${weight}`);
    const item = this.items.find((i) => i.value === value);
    if (!item) throw new Error(`Item not found in pool`);
    item.weight = weight;
    return this;
  }

  /** Adjust an item's weight by a delta. Final weight is clamped to a minimum of 0.001. */
  adjustWeight(value: T, delta: number): this {
    const item = this.items.find((i) => i.value === value);
    if (!item) throw new Error(`Item not found in pool`);
    item.weight = Math.max(0.001, item.weight + delta);
    return this;
  }

  /** Normalize all weights so they sum to 1.0. */
  normalize(): this {
    const total = this.totalWeight();
    if (total === 0) throw new Error(`Cannot normalize: all weights are zero`);
    for (const item of this.items) {
      item.weight = item.weight / total;
    }
    return this;
  }

  /** Return the sum of all weights. */
  totalWeight(): number {
    return this.items.reduce((sum, i) => sum + i.weight, 0);
  }

  /** Number of items in the pool. */
  get size(): number {
    return this.items.length;
  }

  /** Read-only snapshot of all items and their current weights. */
  entries(): ReadonlyArray<WeightedItem<T>> {
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * Select one item at random, weighted by weight.
   * Returns null if the pool is empty.
   */
  pick(): T | null {
    if (this.items.length === 0) return null;
    const total = this.totalWeight();
    let cursor = this.rand() * total;
    for (const item of this.items) {
      cursor -= item.weight;
      if (cursor <= 0) return item.value;
    }
    // Floating-point edge case: return last item
    return this.items[this.items.length - 1].value;
  }

  /**
   * Select N unique items without replacement, each selected by weight.
   * If n >= pool size, returns all items in weighted-random order.
   */
  pickMany(n: number): T[] {
    if (n <= 0) return [];
    const pool = new WeightedPool<T>();
    pool.rand = this.rand;
    pool.items = this.items.map((i) => ({ ...i }));

    const results: T[] = [];
    const count = Math.min(n, this.items.length);

    for (let i = 0; i < count; i++) {
      const picked = pool.pick();
      if (picked === null) break;
      results.push(picked);
      pool.remove(picked);
    }
    return results;
  }
}

// CLI entry point
if (import.meta.main) {
  const pool = new WeightedPool<string>(42);
  pool.add("common", 60).add("uncommon", 30).add("rare", 9).add("legendary", 1);

  console.log("Pool entries:");
  for (const entry of pool.entries()) {
    console.log(`  ${entry.value}: weight=${entry.weight}`);
  }

  console.log("\n10 single picks:");
  const tally: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    const pick = pool.pick()!;
    tally[pick] = (tally[pick] ?? 0) + 1;
  }
  console.log(tally);

  console.log("\npickMany(3):", pool.pickMany(3));

  pool.normalize();
  console.log("\nAfter normalize(), total weight:", pool.totalWeight().toFixed(6));
}
