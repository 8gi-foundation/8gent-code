/**
 * Reusable object pool to reduce GC pressure.
 * @typeparam T Type of objects managed by the pool.
 */
export class ObjectPool<T> {
  private pool: T[] = [];
  private maxSize: number;
  private factory: () => T;
  private resetFn: (obj: T) => void;

  /**
   * Creates an object pool.
   * @param factory Function to create new instances.
   * @param resetFn Function to reset instances before reuse.
   * @param maxSize Maximum number of instances to keep in the pool.
   */
  constructor(factory: () => T, resetFn: (obj: T) => void, maxSize: number) {
    this.factory = factory;
    this.resetFn = resetFn;
    this.maxSize = maxSize;
  }

  /**
   * Acquires an instance from the pool or creates a new one.
   * @returns An instance of T.
   */
  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    } else {
      const obj = this.factory();
      this.resetFn(obj);
      return obj;
    }
  }

  /**
   * Releases an instance back to the pool after resetting it.
   * @param obj The instance to release.
   */
  release(obj: T): void {
    this.resetFn(obj);
    if (this.pool.length < this.maxSize) {
      this.pool.push(obj);
    }
  }

  /**
   * Returns the current number of instances in the pool.
   * @returns Current pool size.
   */
  size(): number {
    return this.pool.length;
  }
}