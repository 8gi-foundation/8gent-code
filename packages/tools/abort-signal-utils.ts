/**
 * AbortSignal utilities for cancellation patterns.
 *
 * Provides composable helpers for merging, racing, timing out, and wrapping
 * AbortSignals across async operations.
 */

/**
 * Merge multiple AbortSignals into one. The returned signal aborts
 * when ANY of the input signals abort.
 */
export function mergeSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        if (!controller.signal.aborted) {
          controller.abort(signal.reason);
        }
      },
      { once: true, signal: controller.signal }
    );
  }

  return controller.signal;
}

/**
 * Create an AbortSignal that automatically aborts after `ms` milliseconds.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Timed out after ${ms}ms`, "TimeoutError"));
  }, ms);

  // Clean up timer if the caller aborts early via their own logic
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  return controller.signal;
}

/**
 * Race multiple AbortSignals - alias for mergeSignals with clearer intent.
 * Returned signal aborts as soon as the first input signal aborts.
 */
export function raceSignals(...signals: AbortSignal[]): AbortSignal {
  return mergeSignals(...signals);
}

/**
 * Register a callback that fires when the signal is aborted.
 * Returns a cleanup function to remove the listener.
 */
export function onAbort(signal: AbortSignal, fn: (reason: unknown) => void): () => void {
  if (signal.aborted) {
    fn(signal.reason);
    return () => {};
  }

  const handler = () => fn(signal.reason);
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

/**
 * Throw an AbortError if the signal is already aborted.
 * Use at async checkpoints to bail out early.
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new DOMException(
      typeof reason === "string" ? reason : "The operation was aborted",
      "AbortError"
    );
  }
}

/**
 * Check whether a signal has already been aborted.
 */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Wrap a promise so it rejects with an AbortError if the signal fires
 * before the promise resolves.
 */
export function abortablePromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const reason = signal.reason;
    return Promise.reject(reason instanceof Error ? reason : new DOMException("AbortError", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = onAbort(signal, (reason) => {
      reject(reason instanceof Error ? reason : new DOMException("AbortError", "AbortError"));
    });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      }
    );
  });
}
