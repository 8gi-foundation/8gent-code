/**
 * Cooperative cancellation tokens for long-running tasks.
 *
 * Pattern: CancellationTokenSource creates tokens. Tokens are passed into
 * async tasks. Tasks check isCancelled or call throwIfCancelled() at
 * yield points. Linked tokens propagate cancellation from parent sources.
 */

export class CancellationError extends Error {
  readonly reason: string | undefined;

  constructor(reason?: string) {
    super(reason ? `Cancelled: ${reason}` : "Cancelled");
    this.name = "CancellationError";
    this.reason = reason;
  }
}

type CancelListener = (reason?: string) => void;

export class CancellationToken {
  private _cancelled = false;
  private _reason: string | undefined;
  private _listeners: CancelListener[] = [];

  /** Whether this token has been cancelled. */
  get isCancelled(): boolean {
    return this._cancelled;
  }

  /** The reason provided when cancelled, if any. */
  get reason(): string | undefined {
    return this._reason;
  }

  /**
   * Register a callback to run when the token is cancelled.
   * If already cancelled, the callback runs synchronously.
   * Returns a cleanup function to unregister the listener.
   */
  onCancel(fn: CancelListener): () => void {
    if (this._cancelled) {
      fn(this._reason);
      return () => {};
    }
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== fn);
    };
  }

  /**
   * Throws a CancellationError if this token has been cancelled.
   * Call this at async yield points (after await) in long-running tasks.
   */
  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new CancellationError(this._reason);
    }
  }

  /** @internal - called only by CancellationTokenSource */
  _cancel(reason?: string): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    for (const fn of this._listeners) {
      try {
        fn(reason);
      } catch {
        // listeners must not throw - swallow silently
      }
    }
    this._listeners = [];
  }

  /** A token that is never cancelled. Useful as a default/no-op. */
  static readonly none: CancellationToken = new CancellationToken();
}

export class CancellationTokenSource {
  private _token: CancellationToken;
  private _disposed = false;

  constructor() {
    this._token = new CancellationToken();
  }

  /** The token controlled by this source. Pass this to tasks. */
  get token(): CancellationToken {
    return this._token;
  }

  /**
   * Cancel the token, optionally with a reason string.
   * Safe to call multiple times - only the first call has effect.
   */
  cancel(reason?: string): void {
    if (!this._disposed) {
      this._token._cancel(reason);
    }
  }

  /** Release resources. Does not cancel. */
  dispose(): void {
    this._disposed = true;
  }

  /**
   * Create a linked source whose token is cancelled when any of
   * the provided tokens are cancelled.
   */
  static createLinked(...tokens: CancellationToken[]): CancellationTokenSource {
    const source = new CancellationTokenSource();
    const cleanups: Array<() => void> = [];

    for (const token of tokens) {
      const cleanup = token.onCancel((reason) => {
        source.cancel(reason);
        for (const fn of cleanups) fn();
      });
      cleanups.push(cleanup);
    }

    const originalDispose = source.dispose.bind(source);
    source.dispose = () => {
      for (const fn of cleanups) fn();
      originalDispose();
    };

    return source;
  }
}
