/**
 * Deferred<T> - externally resolvable promise for async coordination.
 *
 * Useful when you need to resolve or reject a promise from outside its
 * own executor - e.g. wiring agent tool calls to streaming events,
 * coordinating across worktrees, or building timeout-gated gates.
 */

export interface Deferred<T> {
  /** The underlying promise. Await this to wait for resolution. */
  promise: Promise<T>;

  /** Resolve the promise with a value (or another promise). */
  resolve: (value: T | PromiseLike<T>) => void;

  /** Reject the promise with a reason. */
  reject: (reason?: unknown) => void;

  /** True once resolve() or reject() has been called. */
  readonly isSettled: boolean;

  /** True if resolve() was called and the promise is settled. */
  readonly isResolved: boolean;

  /** True if reject() was called and the promise is settled. */
  readonly isRejected: boolean;
}

/**
 * Create an externally resolvable deferred promise.
 *
 * @example
 * const d = deferred<string>();
 * someEventEmitter.once('data', d.resolve);
 * const result = await d.promise; // waits until resolve() is called
 */
export function deferred<T = void>(): Deferred<T> {
  let _resolve!: (value: T | PromiseLike<T>) => void;
  let _reject!: (reason?: unknown) => void;
  let _settled = false;
  let _resolved = false;
  let _rejected = false;

  const promise = new Promise<T>((res, rej) => {
    _resolve = res;
    _reject = rej;
  });

  const d: Deferred<T> = {
    promise,

    resolve(value) {
      if (_settled) return;
      _settled = true;
      _resolved = true;
      _resolve(value);
    },

    reject(reason) {
      if (_settled) return;
      _settled = true;
      _rejected = true;
      _reject(reason);
    },

    get isSettled() {
      return _settled;
    },
    get isResolved() {
      return _resolved;
    },
    get isRejected() {
      return _rejected;
    },
  };

  return d;
}

/**
 * Create a deferred promise that auto-rejects after `ms` milliseconds.
 *
 * @param ms - Timeout in milliseconds.
 * @param message - Optional rejection message. Defaults to "Deferred timed out".
 *
 * @example
 * const d = deferredWithTimeout<string>(5000, "tool response timeout");
 * toolCallEmitter.once('response', d.resolve);
 * const result = await d.promise; // rejects after 5s if no response
 */
export function deferredWithTimeout<T = void>(
  ms: number,
  message = "Deferred timed out",
): Deferred<T> {
  const d = deferred<T>();

  const timer = setTimeout(() => {
    d.reject(new Error(message));
  }, ms);

  // Clear the timer if settled before timeout
  const originalResolve = d.resolve.bind(d);
  const originalReject = d.reject.bind(d);

  (d as { resolve: typeof d.resolve }).resolve = (value) => {
    clearTimeout(timer);
    originalResolve(value);
  };

  (d as { reject: typeof d.reject }).reject = (reason) => {
    clearTimeout(timer);
    originalReject(reason);
  };

  return d;
}

/**
 * Race multiple deferreds - resolves/rejects with whichever settles first.
 * All losers are left unsettled (they do not reject).
 *
 * @example
 * const [a, b] = [deferred<string>(), deferred<string>()];
 * const winner = raceDeferred([a, b]);
 * b.resolve("fast"); // a stays pending, winner resolves "fast"
 */
export function raceDeferred<T>(deferreds: Deferred<T>[]): Promise<T> {
  return Promise.race(deferreds.map((d) => d.promise));
}
