/**
 * Debounce and throttle utilities for controlling function execution rate.
 * Supports leading/trailing edge, cancel, and flush operations.
 */

export interface DebounceOptions {
  /** Fire on the leading edge of the timeout. Default: false */
  leading?: boolean;
  /** Fire on the trailing edge of the timeout. Default: true */
  trailing?: boolean;
  /** Maximum time in ms the function can be delayed. Undefined = no max wait */
  maxWait?: number;
}

export interface ThrottleOptions {
  /** Fire on the leading edge of the interval. Default: true */
  leading?: boolean;
  /** Fire on the trailing edge of the interval. Default: true */
  trailing?: boolean;
}

export interface DebouncedFunction<T extends (...args: unknown[]) => unknown> {
  (...args: Parameters<T>): ReturnType<T> | undefined;
  /** Cancel any pending invocation */
  cancel(): void;
  /** Immediately invoke and cancel any pending invocation */
  flush(): ReturnType<T> | undefined;
  /** Whether a pending invocation is queued */
  pending(): boolean;
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
  options: DebounceOptions = {}
): DebouncedFunction<T> {
  const {
    leading = false,
    trailing = true,
    maxWait,
  } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Parameters<T> | undefined;
  let lastResult: ReturnType<T> | undefined;
  let lastCallTime: number | undefined;
  let lastInvokeTime = 0;

  function invoke(args: Parameters<T>): ReturnType<T> {
    lastInvokeTime = Date.now();
    lastResult = fn(...args) as ReturnType<T>;
    return lastResult;
  }

  function trailingEdge(): ReturnType<T> | undefined {
    timer = undefined;
    if (maxTimer !== undefined) {
      clearTimeout(maxTimer);
      maxTimer = undefined;
    }
    if (trailing && lastArgs) {
      return invoke(lastArgs);
    }
    lastArgs = undefined;
    return lastResult;
  }

  function maxWaitExpired(): void {
    maxTimer = undefined;
    if (lastArgs) {
      lastResult = invoke(lastArgs);
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = setTimeout(trailingEdge, ms);
    }
  }

  const debounced = function (...args: Parameters<T>): ReturnType<T> | undefined {
    const isInvoking = leading && timer === undefined;

    lastArgs = args;
    lastCallTime = Date.now();

    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(trailingEdge, ms);

    if (maxWait !== undefined && maxTimer === undefined) {
      maxTimer = setTimeout(maxWaitExpired, maxWait);
    }

    if (isInvoking) {
      return invoke(args);
    }

    return lastResult;
  } as DebouncedFunction<T>;

  debounced.cancel = function (): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (maxTimer !== undefined) {
      clearTimeout(maxTimer);
      maxTimer = undefined;
    }
    lastArgs = undefined;
    lastCallTime = undefined;
  };

  debounced.flush = function (): ReturnType<T> | undefined {
    if (timer === undefined) return lastResult;
    clearTimeout(timer);
    timer = undefined;
    if (maxTimer !== undefined) {
      clearTimeout(maxTimer);
      maxTimer = undefined;
    }
    if (lastArgs) return invoke(lastArgs);
    return lastResult;
  };

  debounced.pending = function (): boolean {
    return timer !== undefined;
  };

  return debounced;
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
  options: ThrottleOptions = {}
): DebouncedFunction<T> {
  const { leading = true, trailing = true } = options;
  return debounce(fn, ms, {
    leading,
    trailing,
    maxWait: ms,
  });
}
