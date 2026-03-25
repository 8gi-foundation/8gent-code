/**
 * timeout-controller.ts
 *
 * Wraps async operations with configurable timeouts and abort signals.
 * Supports cascading timeouts for nested operations and deadline propagation.
 */

export class TimeoutError extends Error {
  readonly timeout: number;
  constructor(message: string, timeout: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeout = timeout;
  }
}

/**
 * Wraps a promise-returning function with a configurable timeout.
 * The AbortSignal is passed to the function so it can cancel in-progress work.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Propagate parent abort into this controller
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      const onParentAbort = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      controller.signal.addEventListener(
        "abort",
        () => parentSignal.removeEventListener("abort", onParentAbort),
        { once: true }
      );
    }
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(`Operation timed out after ${ms}ms`, ms));
      reject(new TimeoutError(`Operation timed out after ${ms}ms`, ms));
    }, ms);
  });

  try {
    const result = await Promise.race([fn(controller.signal), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TimeoutController manages a deadline across nested async operations.
 * Propagates the same AbortSignal down to all child operations so that
 * cancelling the parent cancels all children.
 */
export class TimeoutController {
  private readonly controller: AbortController;
  private readonly deadline: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number, parentSignal?: AbortSignal) {
    this.controller = new AbortController();
    this.deadline = Date.now() + ms;

    if (parentSignal) {
      if (parentSignal.aborted) {
        this.controller.abort(parentSignal.reason);
      } else {
        const onParentAbort = () => this.controller.abort(parentSignal.reason);
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        this.signal.addEventListener(
          "abort",
          () => parentSignal.removeEventListener("abort", onParentAbort),
          { once: true }
        );
      }
    }

    this.timer = setTimeout(() => {
      this.controller.abort(
        new TimeoutError(`Deadline exceeded after ${ms}ms`, ms)
      );
    }, ms);
  }

  /** The AbortSignal to pass to child operations */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds remaining before deadline */
  get remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /** Whether the deadline has already passed or been aborted */
  get expired(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Creates a child TimeoutController that respects both its own timeout
   * and the parent deadline - whichever comes first wins.
   */
  child(ms: number): TimeoutController {
    const childMs = Math.min(ms, this.remaining);
    return new TimeoutController(childMs, this.signal);
  }

  /**
   * Wraps a function with this controller's signal and remaining deadline.
   */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.expired) {
      throw new TimeoutError("Controller already expired", 0);
    }
    return fn(this.signal);
  }

  /** Cancel the deadline early and clean up the timer */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort(new Error("Cancelled"));
  }

  /** Clear the timer without aborting - call when work completes normally */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
