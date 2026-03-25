/**
 * value-transformer.ts
 * Chainable value transformation pipeline.
 * Status: quarantine - not wired into agent tool registry.
 */

type TransformFn<A, B> = (value: A) => B | Promise<B>;
type PredicateFn<A> = (value: A) => boolean | Promise<boolean>;
type ValidatorFn<A> = (value: A) => boolean | string | Promise<boolean | string>;

export class ValidationError extends Error {
  constructor(message: string, public readonly value: unknown) {
    super(message);
    this.name = "ValidationError";
  }
}

export class Transform<T> {
  private constructor(private readonly _value: Promise<T>) {}

  /** Wrap an initial value in a transform pipeline. */
  static of<T>(value: T | Promise<T>): Transform<T> {
    return new Transform(Promise.resolve(value));
  }

  /** Apply a mapping function to the current value. */
  map<U>(fn: TransformFn<T, U>): Transform<U> {
    return new Transform(this._value.then(fn));
  }

  /**
   * Filter: keep the value if predicate returns true,
   * otherwise resolve to undefined and short-circuit further maps.
   */
  filter(predicate: PredicateFn<T>): Transform<T | undefined> {
    return new Transform(
      this._value.then(async (v) => {
        const keep = await predicate(v);
        return keep ? v : undefined;
      })
    );
  }

  /**
   * Tap: run a side-effect without changing the value.
   * Useful for logging, telemetry, or debug breakpoints.
   */
  tap(fn: (value: T) => void | Promise<void>): Transform<T> {
    return new Transform(
      this._value.then(async (v) => {
        await fn(v);
        return v;
      })
    );
  }

  /**
   * Catch: recover from an error thrown in a previous step.
   * The recovery function receives the error and the last known value (if any).
   */
  catch<U = T>(fn: (err: unknown) => U | Promise<U>): Transform<T | U> {
    return new Transform(this._value.catch(fn));
  }

  /**
   * Default: replace null or undefined with a fallback value.
   */
  default<U>(fallback: U): Transform<Exclude<T, null | undefined> | U> {
    return new Transform(
      this._value.then((v) =>
        (v == null ? fallback : v) as Exclude<T, null | undefined> | U
      )
    );
  }

  /**
   * Validate: assert constraints on the value.
   * - Return true to pass.
   * - Return false to throw a generic ValidationError.
   * - Return a string to throw a ValidationError with that message.
   */
  validate(fn: ValidatorFn<T>): Transform<T> {
    return new Transform(
      this._value.then(async (v) => {
        const result = await fn(v);
        if (result === true) return v;
        if (result === false) throw new ValidationError("Validation failed", v);
        throw new ValidationError(result, v);
      })
    );
  }

  /** Serialize the current value to a JSON string. */
  toJSON(): Transform<string> {
    return new Transform(this._value.then((v) => JSON.stringify(v)));
  }

  /** Coerce the current value to a string via String(). */
  toString(): Transform<string> {
    return new Transform(this._value.then((v) => String(v)));
  }

  /** Resolve the pipeline and return the final value. */
  async value(): Promise<T> {
    return this._value;
  }
}

/**
 * Convenience entry point. Equivalent to Transform.of(value).
 *
 * @example
 * const result = await transform("  hello world  ")
 *   .map((s) => s.trim())
 *   .map((s) => s.toUpperCase())
 *   .validate((s) => s.length > 0 || "String must not be empty")
 *   .tap((s) => console.log("transformed:", s))
 *   .value();
 */
export function transform<T>(value: T | Promise<T>): Transform<T> {
  return Transform.of(value);
}
