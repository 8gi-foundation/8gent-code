/**
 * wrap-fn.ts
 * Function wrapper utilities for cross-cutting concerns.
 * before, after, around, guard, profile, log.
 */

type AnyFn = (...args: any[]) => any;

/**
 * Runs `beforeFn` with the same arguments before calling `fn`.
 * Returns the result of `fn`.
 */
export function before<T extends AnyFn>(fn: T, beforeFn: (...args: Parameters<T>) => void): T {
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    beforeFn.apply(this, args);
    return fn.apply(this, args) as ReturnType<T>;
  } as T;
}

/**
 * Runs `afterFn` with the result and original arguments after `fn` returns.
 * Returns the result of `fn`.
 */
export function after<T extends AnyFn>(
  fn: T,
  afterFn: (result: ReturnType<T>, ...args: Parameters<T>) => void,
): T {
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    const result = fn.apply(this, args) as ReturnType<T>;
    if (result instanceof Promise) {
      return result.then((resolved) => {
        afterFn(resolved, ...args);
        return resolved;
      }) as ReturnType<T>;
    }
    afterFn(result, ...args);
    return result;
  } as T;
}

/**
 * Wraps `fn` with a `wrapper` function that receives `(original, ...args)`.
 * The wrapper controls when and whether to call the original.
 */
export function around<T extends AnyFn>(
  fn: T,
  wrapper: (original: T, ...args: Parameters<T>) => ReturnType<T>,
): T {
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    const bound = fn.bind(this) as T;
    return wrapper(bound, ...args);
  } as T;
}

/**
 * Guards `fn` behind a `predicate`. If predicate returns false, returns `fallback` instead.
 * `fallback` can be a value or a function with the same signature as `fn`.
 */
export function guard<T extends AnyFn>(
  fn: T,
  predicate: (...args: Parameters<T>) => boolean,
  fallback?: ReturnType<T> | ((...args: Parameters<T>) => ReturnType<T>),
): T {
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    if (!predicate.apply(this, args)) {
      if (typeof fallback === "function") {
        return (fallback as (...args: Parameters<T>) => ReturnType<T>).apply(this, args);
      }
      return fallback as ReturnType<T>;
    }
    return fn.apply(this, args) as ReturnType<T>;
  } as T;
}

export interface ProfileResult<T> {
  result: T;
  durationMs: number;
}

/**
 * Wraps `fn` so each call returns `{ result, durationMs }` instead of the raw return value.
 * Works with async functions - resolves after the promise settles.
 */
export function profile<T extends AnyFn>(
  fn: T,
): (...args: Parameters<T>) => ProfileResult<ReturnType<T>> | Promise<ProfileResult<Awaited<ReturnType<T>>>> {
  return function (this: unknown, ...args: Parameters<T>) {
    const start = performance.now();
    const result = fn.apply(this, args) as ReturnType<T>;
    if (result instanceof Promise) {
      return result.then((resolved) => ({
        result: resolved,
        durationMs: performance.now() - start,
      }));
    }
    return {
      result,
      durationMs: performance.now() - start,
    };
  };
}

export interface LogOptions {
  /** Called before invocation. Defaults to console.log. */
  logger?: (message: string, ...extra: unknown[]) => void;
  /** Label used in log messages. Defaults to fn.name or "fn". */
  label?: string;
  /** Log arguments passed to the function. Default: true. */
  logArgs?: boolean;
  /** Log the return value. Default: true. */
  logReturn?: boolean;
}

/**
 * Wraps `fn` and logs each call (arguments + return value) via `logger`.
 * Handles async functions transparently.
 */
export function log<T extends AnyFn>(fn: T, options: LogOptions = {}): T {
  const {
    logger = console.log,
    label = fn.name || "fn",
    logArgs = true,
    logReturn = true,
  } = options;

  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    if (logArgs) {
      logger(`[${label}] called`, ...args);
    } else {
      logger(`[${label}] called`);
    }

    const result = fn.apply(this, args) as ReturnType<T>;

    if (result instanceof Promise) {
      return result.then((resolved) => {
        if (logReturn) logger(`[${label}] returned`, resolved);
        return resolved;
      }) as ReturnType<T>;
    }

    if (logReturn) logger(`[${label}] returned`, result);
    return result;
  } as T;
}
