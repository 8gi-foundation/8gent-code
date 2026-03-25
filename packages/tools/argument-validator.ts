/**
 * Fluent argument validator with descriptive error messages.
 *
 * Usage:
 *   check(value, 'paramName').isString().minLength(1)
 *   check(count, 'count').isNumber().inRange(0, 100)
 *   check(status, 'status').isOneOf(['active', 'inactive'])
 */

export class ArgumentError extends Error {
  constructor(
    public readonly param: string,
    message: string,
  ) {
    super(`[${param}] ${message}`);
    this.name = 'ArgumentError';
  }
}

export class Validator<T> {
  constructor(
    private readonly value: T,
    private readonly name: string,
  ) {}

  isString(message?: string): Validator<string> {
    if (typeof this.value !== 'string') {
      throw new ArgumentError(
        this.name,
        message ?? `expected string, got ${typeof this.value}`,
      );
    }
    return this as unknown as Validator<string>;
  }

  isNumber(message?: string): Validator<number> {
    if (typeof this.value !== 'number' || Number.isNaN(this.value)) {
      throw new ArgumentError(
        this.name,
        message ?? `expected number, got ${typeof this.value}`,
      );
    }
    return this as unknown as Validator<number>;
  }

  isBoolean(message?: string): Validator<boolean> {
    if (typeof this.value !== 'boolean') {
      throw new ArgumentError(
        this.name,
        message ?? `expected boolean, got ${typeof this.value}`,
      );
    }
    return this as unknown as Validator<boolean>;
  }

  isArray(message?: string): Validator<unknown[]> {
    if (!Array.isArray(this.value)) {
      throw new ArgumentError(
        this.name,
        message ?? `expected array, got ${typeof this.value}`,
      );
    }
    return this as unknown as Validator<unknown[]>;
  }

  isDefined(message?: string): Validator<NonNullable<T>> {
    if (this.value === null || this.value === undefined) {
      throw new ArgumentError(
        this.name,
        message ?? `value is required but received ${this.value}`,
      );
    }
    return this as unknown as Validator<NonNullable<T>>;
  }

  minLength(min: number, message?: string): this {
    const len =
      typeof this.value === 'string' || Array.isArray(this.value)
        ? (this.value as string | unknown[]).length
        : null;
    if (len === null || len < min) {
      throw new ArgumentError(
        this.name,
        message ?? `length must be >= ${min}, got ${len ?? 'N/A'}`,
      );
    }
    return this;
  }

  maxLength(max: number, message?: string): this {
    const len =
      typeof this.value === 'string' || Array.isArray(this.value)
        ? (this.value as string | unknown[]).length
        : null;
    if (len === null || len > max) {
      throw new ArgumentError(
        this.name,
        message ?? `length must be <= ${max}, got ${len ?? 'N/A'}`,
      );
    }
    return this;
  }

  inRange(min: number, max: number, message?: string): this {
    const n = this.value as unknown as number;
    if (typeof n !== 'number' || n < min || n > max) {
      throw new ArgumentError(
        this.name,
        message ?? `must be between ${min} and ${max}, got ${n}`,
      );
    }
    return this;
  }

  matches(regex: RegExp, message?: string): this {
    if (typeof this.value !== 'string' || !regex.test(this.value)) {
      throw new ArgumentError(
        this.name,
        message ?? `must match pattern ${regex.toString()}, got "${this.value}"`,
      );
    }
    return this;
  }

  isOneOf<U>(values: U[], message?: string): Validator<U> {
    if (!(values as unknown[]).includes(this.value)) {
      throw new ArgumentError(
        this.name,
        message ??
          `must be one of [${values.map(String).join(', ')}], got "${this.value}"`,
      );
    }
    return this as unknown as Validator<U>;
  }

  satisfies(predicate: (v: T) => boolean, message?: string): this {
    if (!predicate(this.value)) {
      throw new ArgumentError(
        this.name,
        message ?? `value "${this.value}" did not satisfy custom constraint`,
      );
    }
    return this;
  }

  /** Unwrap the validated value. */
  get(): T {
    return this.value;
  }
}

/**
 * Entry point. Returns a fluent Validator for the given value.
 *
 * @param value - The value to validate.
 * @param name  - Optional parameter name shown in error messages (default: "value").
 */
export function check<T>(value: T, name = 'value'): Validator<T> {
  return new Validator(value, name);
}
