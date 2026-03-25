/**
 * ObjectPool<T> - generic object pool allocator.
 * Pre-allocates objects and reuses them via acquire/release to reduce GC
 * pressure in hot paths: agent loops, tool dispatch, streaming.
 */

export interface PoolStats {
  capacity: number;
  available: number;
  inUse: number;
  acquireCount: number;
  releaseCount: number;
  growCount: number;
  missCount: number;
}

export interface PoolOptions {
  initialSize?: number;
  growBy?: number;
  maxSize?: number;
  reset?: <T>(obj: T) => void;
}

export class ObjectPool<T> {
  private readonly _factory: () => T;
  private readonly _reset: ((obj: T) => void) | undefined;
  private readonly _growBy: number;
  private readonly _maxSize: number;
  private _pool: T[];
  private _inUse: Set<T>;
  private _acquireCount = 0;
  private _releaseCount = 0;
  private _growCount = 0;
  private _missCount = 0;

  constructor(factory: () => T, options: PoolOptions = {}) {
    const { initialSize = 16, growBy = 8, maxSize = 0, reset } = options;
    this._factory = factory;
    this._reset = reset;
    this._growBy = growBy;
    this._maxSize = maxSize;
    this._pool = [];
    this._inUse = new Set();
    this._preallocate(initialSize);
  }

  /** Acquire an object from the pool. Returns null if maxSize reached. */
  acquire(): T | null {
    this._acquireCount++;
    if (this._pool.length === 0) {
      const canGrow =
        this._maxSize === 0 ||
        this._inUse.size + this._pool.length < this._maxSize;
      if (\!canGrow) return null;
      this._grow();
      this._missCount++;
    }
    const obj = this._pool.pop()\!;
    this._inUse.add(obj);
    return obj;
  }

  /** Release an object back to the pool. Silently ignores foreign objects. */
  release(obj: T): void {
    if (\!this._inUse.has(obj)) return;
    this._releaseCount++;
    this._inUse.delete(obj);
    if (this._reset) this._reset(obj);
    this._pool.push(obj);
  }

  /** Scoped acquire + auto-release. Throws if pool is exhausted. */
  async use<R>(fn: (obj: T) => Promise<R>): Promise<R> {
    const obj = this.acquire();
    if (obj === null) throw new Error("ObjectPool exhausted - maxSize reached");
    try { return await fn(obj); } finally { this.release(obj); }
  }

  /** Current snapshot of pool stats. */
  stats(): PoolStats {
    return {
      capacity: this._pool.length + this._inUse.size,
      available: this._pool.length,
      inUse: this._inUse.size,
      acquireCount: this._acquireCount,
      releaseCount: this._releaseCount,
      growCount: this._growCount,
      missCount: this._missCount,
    };
  }

  private _preallocate(count: number): void {
    for (let i = 0; i < count; i++) this._pool.push(this._factory());
  }

  private _grow(): void {
    const n =
      this._maxSize > 0
        ? Math.min(this._growBy, this._maxSize - this._pool.length - this._inUse.size)
        : this._growBy;
    this._preallocate(n);
    this._growCount++;
  }
}
