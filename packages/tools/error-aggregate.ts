/**
 * ErrorCollector - gather multiple errors and throw once as AggregateError.
 * Useful in validation passes, parallel task runs, or any flow where you want
 * to accumulate failures before surfacing them rather than short-circuiting on
 * the first one.
 */

export interface CollectedError {
  error: Error;
  label?: string;
}

export interface FormatOptions {
  /** Include stack traces in output. Defaults to false. */
  stacks?: boolean;
  /** Separator between error entries. Defaults to "\n". */
  separator?: string;
}

export class ErrorCollector {
  private collected: CollectedError[] = [];

  /**
   * Add a single error, with an optional label for context.
   */
  add(error: unknown, label?: string): void {
    const err = toError(error);
    this.collected.push({ error: err, label });
  }

  /**
   * Add multiple errors at once.
   * Each element may be an Error, a string, or a CollectedError.
   */
  addAll(errors: Array<unknown | CollectedError>): void {
    for (const e of errors) {
      if (isCollectedError(e)) {
        this.collected.push(e);
      } else {
        this.add(e);
      }
    }
  }

  /** Returns true if at least one error has been collected. */
  hasErrors(): boolean {
    return this.collected.length > 0;
  }

  /** Total number of collected errors. */
  count(): number {
    return this.collected.length;
  }

  /** Return a snapshot of all collected errors. */
  errors(): ReadonlyArray<CollectedError> {
    return this.collected;
  }

  /**
   * Convert to a native AggregateError.
   * The AggregateError message is a one-line summary; individual errors are
   * available on `.errors`.
   */
  toAggregateError(message?: string): AggregateError {
    const msg =
      message ??
      `${this.collected.length} error${this.collected.length === 1 ? "" : "s"} collected`;
    return new AggregateError(
      this.collected.map((c) => c.error),
      msg
    );
  }

  /**
   * Format collected errors as a human-readable string.
   * Suitable for log output or terminal display.
   */
  format(opts: FormatOptions = {}): string {
    const { stacks = false, separator = "\n" } = opts;
    if (this.collected.length === 0) return "(no errors)";

    return this.collected
      .map((c, i) => {
        const prefix = c.label ? `[${c.label}] ` : `[${i + 1}] `;
        const body = stacks && c.error.stack ? c.error.stack : c.error.message;
        return `${prefix}${body}`;
      })
      .join(separator);
  }

  /**
   * If any errors have been collected, throw them as an AggregateError.
   * No-op if the collector is empty.
   */
  throw(message?: string): void {
    if (this.hasErrors()) {
      throw this.toAggregateError(message);
    }
  }

  /** Clear all collected errors. */
  reset(): void {
    this.collected = [];
  }
}

/**
 * Run an array of synchronous functions, collect any errors each one throws,
 * then return an ErrorCollector with all failures.
 * All functions run regardless of individual failures.
 */
export function collectErrors(
  fns: Array<() => void>,
  labels?: string[]
): ErrorCollector {
  const collector = new ErrorCollector();
  for (let i = 0; i < fns.length; i++) {
    try {
      fns[i]();
    } catch (err) {
      collector.add(err, labels?.[i]);
    }
  }
  return collector;
}

// --- internal helpers ---

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(String(value));
}

function isCollectedError(value: unknown): value is CollectedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as CollectedError).error instanceof Error
  );
}
