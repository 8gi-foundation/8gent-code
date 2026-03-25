/**
 * fn-throttle-v2
 * Improved function throttle with queue mode, abort signal, flush, cancel, and pending tracking.
 */

export interface ThrottleOptions {
  /** Fire on leading edge (default: true) */
  leading?: boolean;
  /** Fire on trailing edge (default: true) */
  trailing?: boolean;
  /**
   * Queue mode: buffer excess calls and replay them after the throttle window.
   * When false (default), excess calls are dropped and only the last trailing call fires.
   */
  queue?: boolean;
  /** AbortSignal to cancel all pending/queued invocations */
  signal?: AbortSignal;
}

export interface ThrottleHandle<T extends (...args: unknown[]) => unknown> {
  /** The throttled wrapper function */
  fn: (...args: Parameters<T>) => void;
  /** Flush: immediately invoke any pending trailing call (or next queued call) */
  flush: () => void;
  /** Cancel: drop all pending and queued calls without invoking */
  cancel: () => void;
  /** Number of calls waiting in the queue (queue mode only) */
  get pending(): number;
}

/**
 * Create a throttled version of `fn` that fires at most once per `ms` milliseconds.
 *
 * @param fn   The function to throttle
 * @param ms   Throttle window in milliseconds
 * @param opts Options: leading, trailing, queue mode, abort signal
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
  opts: ThrottleOptions = {},
): ThrottleHandle<T> {
  const { leading = true, trailing = true, queue = false, signal } = opts;

  let lastInvokeTime = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let trailingArgs: Parameters<T> | null = null;
  const callQueue: Array<Parameters<T>> = [];
  let aborted = false;

  function clearTrailing() {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    trailingArgs = null;
  }

  function invoke(args: Parameters<T>) {
    if (aborted) return;
    lastInvokeTime = Date.now();
    fn(...args);
  }

  function scheduleTrailing(args: Parameters<T>, delay: number) {
    clearTrailing();
    if (!trailing) return;
    trailingArgs = args;
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      if (aborted) return;

      if (queue && callQueue.length > 0) {
        // In queue mode, replay next queued call instead of just trailing
        const next = callQueue.shift()!;
        invoke(next);
        if (callQueue.length > 0 || trailingArgs) {
          scheduleTrailing(trailingArgs ?? next, ms);
          trailingArgs = null;
        }
      } else if (trailingArgs) {
        const saved = trailingArgs;
        trailingArgs = null;
        invoke(saved);
        // If there are queued calls still waiting, restart the cycle
        if (queue && callQueue.length > 0) {
          scheduleTrailing(callQueue.shift()!, ms);
        }
      }
    }, delay);
  }

  function throttled(...args: Parameters<T>): void {
    if (aborted) return;

    const now = Date.now();
    const elapsed = now - lastInvokeTime;
    const remaining = ms - elapsed;

    if (remaining <= 0) {
      // Window has passed — fire immediately on leading edge
      clearTrailing();
      if (leading) {
        invoke(args);
      } else {
        // Leading disabled: schedule as trailing at end of window
        scheduleTrailing(args, ms);
      }
    } else {
      // Still inside throttle window
      if (queue) {
        callQueue.push(args);
      } else {
        // Drop previous trailing, keep only latest
        scheduleTrailing(args, remaining);
      }
    }
  }

  function flush() {
    if (aborted) return;
    clearTrailing();
    if (queue && callQueue.length > 0) {
      invoke(callQueue.shift()!);
      if (callQueue.length > 0) scheduleTrailing(callQueue[0], ms);
    } else if (trailingArgs) {
      const saved = trailingArgs;
      trailingArgs = null;
      invoke(saved);
    }
  }

  function cancel() {
    clearTrailing();
    callQueue.length = 0;
  }

  // Wire up abort signal
  if (signal) {
    signal.addEventListener("abort", () => {
      aborted = true;
      cancel();
    });
  }

  return {
    fn: throttled,
    flush,
    cancel,
    get pending() {
      return callQueue.length + (trailingArgs ? 1 : 0);
    },
  };
}
