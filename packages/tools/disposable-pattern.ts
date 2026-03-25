/**
 * Disposable pattern for deterministic resource cleanup.
 *
 * Provides:
 *   - Disposable interface (sync + async)
 *   - using() helper - wraps a resource, ensures dispose() is called after fn
 *   - usingAsync() helper - async variant
 *   - DisposableStack - manages multiple resources, disposes in LIFO order
 */

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// using() - sync helper
// ---------------------------------------------------------------------------

/**
 * Executes fn with resource, then calls resource.dispose() regardless of
 * whether fn throws.
 *
 * @example
 *   const result = using(new FileHandle(path), (f) => f.read());
 */
export function using<T extends Disposable, R>(
  resource: T,
  fn: (resource: T) => R,
): R {
  try {
    return fn(resource);
  } finally {
    const result = resource.dispose();
    // If dispose returned a Promise, swallow it silently in sync context.
    // Callers who need async cleanup should use usingAsync().
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// usingAsync() - async helper
// ---------------------------------------------------------------------------

/**
 * Async variant of using(). Awaits both fn and dispose().
 *
 * @example
 *   const rows = await usingAsync(new DbConnection(url), (db) => db.query(sql));
 */
export async function usingAsync<T extends Disposable, R>(
  resource: T,
  fn: (resource: T) => Promise<R>,
): Promise<R> {
  try {
    return await fn(resource);
  } finally {
    await resource.dispose();
  }
}

// ---------------------------------------------------------------------------
// DisposableStack - manages multiple resources
// ---------------------------------------------------------------------------

/**
 * Collects multiple Disposable resources and disposes them in LIFO order.
 * Itself implements Disposable, so it can be passed to using().
 *
 * @example
 *   const stack = new DisposableStack();
 *   const conn = stack.add(new DbConnection(url));
 *   const lock = stack.add(new FileLock(path));
 *   try {
 *     // use conn and lock
 *   } finally {
 *     await stack.dispose(); // disposes lock first, then conn
 *   }
 */
export class DisposableStack implements Disposable {
  private readonly _resources: Disposable[] = [];
  private _disposed = false;

  /** Register a resource for cleanup. Returns the resource for chaining. */
  add<T extends Disposable>(resource: T): T {
    if (this._disposed) {
      throw new Error("Cannot add to an already-disposed DisposableStack");
    }
    this._resources.push(resource);
    return resource;
  }

  /** Register an arbitrary cleanup function (no resource object needed). */
  defer(fn: () => void | Promise<void>): void {
    this.add({ dispose: fn });
  }

  /** Whether dispose() has already been called. */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose all registered resources in reverse (LIFO) order.
   * Errors from individual disposals are collected and re-thrown as an
   * AggregateError so all resources are given a chance to clean up.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    const errors: unknown[] = [];

    for (let i = this._resources.length - 1; i >= 0; i--) {
      try {
        await this._resources[i].dispose();
      } catch (err) {
        errors.push(err);
      }
    }

    this._resources.length = 0;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} dispose errors`);
    }
  }
}
