/**
 * error-chain.ts
 * Chainable error context wrapping for debugging multi-layer failures.
 *
 * Usage:
 *   import { ChainedError, wrap } from './error-chain';
 *
 *   try {
 *     await db.query(sql);
 *   } catch (err) {
 *     throw wrap(err, { layer: 'database', sql, userId });
 *   }
 */

export interface ErrorContext {
  [key: string]: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  context: ErrorContext;
  stack: string | undefined;
  cause: SerializedError | null;
}

export class ChainedError extends Error {
  readonly context: ErrorContext;
  readonly cause: Error | ChainedError | null;

  constructor(
    message: string,
    context: ErrorContext = {},
    cause: Error | ChainedError | null = null
  ) {
    super(message);
    this.name = 'ChainedError';
    this.context = context;
    this.cause = cause;

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChainedError);
    }
  }

  /**
   * Full cause chain as a concatenated stack string.
   * Each layer is separated by a "Caused by:" header.
   */
  get fullStack(): string {
    const parts: string[] = [this.stack ?? `${this.name}: ${this.message}`];
    let current: Error | ChainedError | null = this.cause;
    while (current) {
      parts.push(
        `Caused by: ${current.stack ?? `${current.name}: ${current.message}`}`
      );
      current =
        current instanceof ChainedError
          ? (current.cause as Error | ChainedError | null)
          : (current.cause as unknown as Error | null) ?? null;
    }
    return parts.join('\n');
  }

  /**
   * Serialize the full error chain to a plain object.
   * Safe to JSON.stringify - no circular references.
   */
  toJSON(): SerializedError {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      stack: this.stack,
      cause: serializeCause(this.cause),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeCause(
  err: Error | ChainedError | null | undefined
): SerializedError | null {
  if (!err) return null;
  if (err instanceof ChainedError) return err.toJSON();
  return {
    name: err.name,
    message: err.message,
    context: {},
    stack: err.stack,
    cause: serializeCause(
      (err.cause as Error | null | undefined) ?? null
    ),
  };
}

/**
 * Wrap any thrown value with additional context.
 *
 * @param error - The original error (or unknown throw value)
 * @param context - Key-value pairs added to this layer
 * @param message - Optional override message; defaults to the original message
 * @returns A new ChainedError with the original as its cause
 */
export function wrap(
  error: unknown,
  context: ErrorContext = {},
  message?: string
): ChainedError {
  if (error instanceof ChainedError) {
    return new ChainedError(
      message ?? error.message,
      { ...error.context, ...context },
      error.cause
    );
  }

  const cause =
    error instanceof Error
      ? error
      : new Error(String(error));

  return new ChainedError(
    message ?? cause.message,
    context,
    cause
  );
}

/**
 * Type-guard: is this value a ChainedError?
 */
export function isChainedError(value: unknown): value is ChainedError {
  return value instanceof ChainedError;
}
