/**
 * optional-chain.ts
 *
 * Safe optional chaining with fallbacks. Deep access to nested objects
 * without throwing. Supports dot paths, array indexing, method calls,
 * and type narrowing.
 *
 * Usage:
 *   chain(obj).get('a.b[0].c').or('default')
 *   tryGet(obj, 'a.b.c', fallback)
 *   tryCall(obj, 'method', [args], fallback)
 */

// Resolve a dot-notation path with optional array indexing: 'a.b[2].c'
function resolvePath(root: unknown, path: string): unknown {
  if (root === null || root === undefined) return undefined;

  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let cursor: unknown = root;

  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object' && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }

  return cursor;
}

// ---------------------------------------------------------------------------
// ChainBuilder - fluent API
// ---------------------------------------------------------------------------

class ChainBuilder<T> {
  private readonly value: T | undefined;

  constructor(value: T | undefined) {
    this.value = value;
  }

  /** Resolve a dot/bracket path from the current value. */
  get(path: string): ChainBuilder<unknown> {
    const resolved = resolvePath(this.value, path);
    return new ChainBuilder(resolved);
  }

  /** Return the value or a fallback if the value is null/undefined. */
  or<F>(fallback: F): T | F {
    return this.value !== null && this.value !== undefined
      ? this.value
      : fallback;
  }

  /** Return the value if it satisfies a type guard, else undefined. */
  narrow<N extends T>(guard: (v: T) => v is N): ChainBuilder<N> {
    if (this.value !== undefined && this.value !== null && guard(this.value as T)) {
      return new ChainBuilder(this.value as N);
    }
    return new ChainBuilder<N>(undefined);
  }

  /** Check if a value exists (not null/undefined). */
  exists(): boolean {
    return this.value !== null && this.value !== undefined;
  }

  /** Unwrap the current value (may be undefined). */
  unwrap(): T | undefined {
    return this.value;
  }

  /** Apply a transform if the value exists, else propagate undefined. */
  map<R>(fn: (v: T) => R): ChainBuilder<R> {
    if (this.value !== null && this.value !== undefined) {
      return new ChainBuilder(fn(this.value as T));
    }
    return new ChainBuilder<R>(undefined);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start a fluent optional chain. */
export function chain<T>(value: T): ChainBuilder<T> {
  return new ChainBuilder(value);
}

/**
 * Safely retrieve a deep value by dot/bracket path.
 * Returns fallback if any segment is null/undefined.
 *
 * @example
 *   tryGet(user, 'address.city', 'Unknown')
 *   tryGet(list, '[0].name', null)
 */
export function tryGet<F = undefined>(
  obj: unknown,
  path: string,
  fallback?: F
): unknown | F {
  const resolved = resolvePath(obj, path);
  if (resolved === null || resolved === undefined) {
    return fallback !== undefined ? fallback : undefined;
  }
  return resolved;
}

/**
 * Safely call a method on an object by name.
 * Returns fallback if the method doesn't exist or throws.
 *
 * @example
 *   tryCall(arr, 'find', [x => x.id === 1], null)
 *   tryCall(str, 'toUpperCase', [], '')
 */
export function tryCall<F = undefined>(
  obj: unknown,
  method: string,
  args: unknown[] = [],
  fallback?: F
): unknown | F {
  try {
    if (obj === null || obj === undefined) return fallback;
    const target = obj as Record<string, unknown>;
    if (typeof target[method] !== 'function') return fallback;
    return (target[method] as (...a: unknown[]) => unknown)(...args);
  } catch {
    return fallback;
  }
}
