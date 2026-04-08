/**
 * ErrorMap - maps error types to recovery strategies.
 *
 * Features:
 * - register(ErrorClass, handler) - bind a handler to an error type
 * - handle(error) - dispatch to the best matching handler
 * - Inheritance matching - walks prototype chain to find nearest ancestor handler
 * - Priority ordering - higher priority wins when multiple handlers match the same class
 * - Default handler - fallback when no match is found
 */

export type ErrorHandler<T extends Error = Error> = (
  error: T
) => void | Promise<void>;

export type RecoveryResult =
  | { matched: true; handlerKey: string }
  | { matched: false };

interface HandlerEntry {
  ctor: new (...args: any[]) => Error;
  handler: ErrorHandler<Error>;
  priority: number;
}

export class ErrorMap {
  private entries: HandlerEntry[] = [];
  private defaultHandler: ErrorHandler<Error> | null = null;

  /**
   * Register a handler for a specific error class.
   *
   * @param ErrorClass - The error constructor to match (including subclasses).
   * @param handler    - Called when a matching error is dispatched.
   * @param priority   - Higher value = preferred when multiple entries match
   *                     the same constructor directly. Defaults to 0.
   */
  register<T extends Error>(
    ErrorClass: new (...args: any[]) => T,
    handler: ErrorHandler<T>,
    priority = 0
  ): this {
    this.entries.push({
      ctor: ErrorClass as HandlerEntry["ctor"],
      handler: handler as ErrorHandler<Error>,
      priority,
    });
    return this;
  }

  /**
   * Set the default handler - invoked when no registered class matches.
   */
  setDefault(handler: ErrorHandler<Error>): this {
    this.defaultHandler = handler;
    return this;
  }

  /**
   * Dispatch an error to its best-matching handler.
   *
   * Matching algorithm:
   * 1. Walk the error prototype chain from most-specific to most-general.
   * 2. At each level, collect all entries whose ctor matches that prototype.
   * 3. The first level that has at least one entry wins; ties broken by priority (desc).
   * 4. If nothing matches, invoke the default handler (if set).
   */
  async handle(error: Error): Promise<RecoveryResult> {
    const match = this.resolve(error);

    if (match) {
      await match.handler(error);
      return { matched: true, handlerKey: match.ctor.name };
    }

    if (this.defaultHandler) {
      await this.defaultHandler(error);
      return { matched: true, handlerKey: "__default__" };
    }

    return { matched: false };
  }

  /**
   * Synchronous variant - throws if a handler returns a Promise.
   */
  handleSync(error: Error): RecoveryResult {
    const match = this.resolve(error);

    if (match) {
      const result = match.handler(error);
      if (result instanceof Promise) {
        throw new TypeError(
          'ErrorMap.handleSync: handler for "' + match.ctor.name + '" returned a Promise. Use handle() instead.'
        );
      }
      return { matched: true, handlerKey: match.ctor.name };
    }

    if (this.defaultHandler) {
      const result = this.defaultHandler(error);
      if (result instanceof Promise) {
        throw new TypeError(
          "ErrorMap.handleSync: default handler returned a Promise. Use handle() instead."
        );
      }
      return { matched: true, handlerKey: "__default__" };
    }

    return { matched: false };
  }

  /**
   * Check whether a handler exists for the given error without invoking it.
   */
  has(error: Error): boolean {
    return this.resolve(error) !== null || this.defaultHandler !== null;
  }

  private resolve(error: Error): HandlerEntry | null {
    let proto: any = Object.getPrototypeOf(error);

    while (proto !== null) {
      const candidates = this.entries.filter(
        (e) => e.ctor === proto.constructor
      );

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.priority - a.priority);
        return candidates[0];
      }

      proto = Object.getPrototypeOf(proto);
    }

    return null;
  }
}
