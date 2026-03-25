/**
 * TaskAbortController
 *
 * Hierarchical abort controller for nested async tasks. Extends the native
 * AbortController with child spawning, reason tracking, onAbort callbacks,
 * and optional timeout-based auto-abort.
 */

export type AbortReason =
  | { type: "user"; message?: string }
  | { type: "timeout"; timeoutMs: number }
  | { type: "parent"; parentReason?: AbortReason }
  | { type: "error"; error: unknown };

export interface TaskAbortControllerOptions {
  /** Auto-abort after this many milliseconds. */
  timeoutMs?: number;
  /** Called synchronously when abort() is invoked. */
  onAbort?: (reason: AbortReason) => void;
}

export class TaskAbortController extends AbortController {
  private _reason: AbortReason | undefined;
  private _children: Set<TaskAbortController> = new Set();
  private _onAbort: ((reason: AbortReason) => void) | undefined;
  private _timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  private _parentUnsubscribe: (() => void) | undefined;

  constructor(options: TaskAbortControllerOptions = {}) {
    super();
    this._onAbort = options.onAbort;

    if (options.timeoutMs !== undefined) {
      const ms = options.timeoutMs;
      this._timeoutHandle = setTimeout(() => {
        this.abort({ type: "timeout", timeoutMs: ms });
      }, ms);
    }
  }

  /** Whether this controller has been aborted. */
  get isAborted(): boolean {
    return this.signal.aborted;
  }

  /** The structured reason this controller was aborted, if any. */
  get reason(): AbortReason | undefined {
    return this._reason;
  }

  /**
   * Abort this controller and propagate to all children.
   * Accepts an optional structured reason; defaults to a user abort.
   */
  override abort(reason: AbortReason = { type: "user" }): void {
    if (this.isAborted) return;

    this._reason = reason;
    this._clearTimeout();
    this._onAbort?.(reason);

    // Propagate to children before calling super so children abort first
    for (const child of this._children) {
      if (!child.isAborted) {
        child.abort({ type: "parent", parentReason: reason });
      }
    }
    this._children.clear();

    super.abort(reason);
  }

  /**
   * Spawn a child TaskAbortController that is automatically aborted when this
   * parent is aborted. The child can also be aborted independently.
   */
  child(options: TaskAbortControllerOptions = {}): TaskAbortController {
    if (this.isAborted) {
      // Parent already aborted - return a pre-aborted child
      const c = new TaskAbortController(options);
      c.abort({ type: "parent", parentReason: this._reason });
      return c;
    }

    const c = new TaskAbortController(options);
    this._children.add(c);

    // Remove child from set when it self-aborts so we don't leak references
    const cleanup = () => this._children.delete(c);
    c.signal.addEventListener("abort", cleanup, { once: true });
    c._parentUnsubscribe = cleanup;

    return c;
  }

  /**
   * Release resources held by this controller without aborting it.
   * Call this when a task completes normally.
   */
  dispose(): void {
    this._clearTimeout();
    this._parentUnsubscribe?.();
    this._children.clear();
  }

  private _clearTimeout(): void {
    if (this._timeoutHandle !== undefined) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = undefined;
    }
  }
}

/**
 * Run an async task with a TaskAbortController scoped to its lifetime.
 * The controller is automatically disposed when the task settles.
 */
export async function withAbortController<T>(
  fn: (ctrl: TaskAbortController) => Promise<T>,
  options: TaskAbortControllerOptions = {}
): Promise<T> {
  const ctrl = new TaskAbortController(options);
  try {
    return await fn(ctrl);
  } finally {
    ctrl.dispose();
  }
}
