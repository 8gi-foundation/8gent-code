interface MemoizeOptions {
  keyResolver?: (...args: any[]) => string;
  maxSize?: number;
}

/**
 * Cache with FIFO eviction policy.
 */
export class Cache {
  private map = new Map<string, any>();
  private keys: string[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): any {
    return this.map.get(key);
  }

  set(key: string, value: any): void {
    if (this.map.has(key)) {
      this.map.set(key, value);
      return;
    }
    if (this.keys.length >= this.maxSize) {
      const oldest = this.keys.shift();
      if (oldest) {
        this.map.delete(oldest);
      }
    }
    this.keys.push(key);
    this.map.set(key, value);
  }

  delete(key: string): void {
    const index = this.keys.indexOf(key);
    if (index !== -1) {
      this.keys.splice(index, 1);
    }
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.keys.length = 0;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

/**
 * Memoizes a pure function with configurable cache key and size limit.
 * @param fn The function to memoize.
 * @param options Configuration options.
 * @returns Memoized function with cache methods.
 */
export function memoize<T extends (...args: any[]) => any>(
  fn: T,
  options: MemoizeOptions = {}
): T & { cache: Cache } {
  const { keyResolver = (...args: any[]) => JSON.stringify(args), maxSize = 100 } = options;
  const cache = new Cache(maxSize);

  const memoized = function (...args: Parameters<T>): ReturnType<T> {
    const key = keyResolver(...args);
    if (cache.has(key)) {
      return cache.get(key) as ReturnType<T>;
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  } as T & { cache: Cache };

  memoized.cache = cache;
  return memoized;
}