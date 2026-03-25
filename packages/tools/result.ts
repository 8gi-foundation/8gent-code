/**
 * Type representing a Result with either a success value or an error
 */
type Result<T, E> = Ok<T, E> | Err<T, E>;

interface Ok<T, E> {
  tag: 'Ok';
  value: T;
}

interface Err<T, E> {
  tag: 'Err';
  error: E;
}

/**
 * Create a successful Result
 * @param value The value
 * @returns Result<T, never>
 */
function ok<T, E>(value: T): Result<T, E> {
  return { tag: 'Ok', value };
}

/**
 * Create an erroneous Result
 * @param error The error
 * @returns Result<never, E>
 */
function err<T, E>(error: E): Result<T, E> {
  return { tag: 'Err', error };
}

/**
 * Map the value of a successful Result
 * @param result The Result
 * @param f The mapping function
 * @returns New Result with transformed value
 */
function map<T, E, U>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
  if (result.tag === 'Ok') {
    return ok(f(result.value));
  }
  return result;
}

/**
 * Flat map a successful Result to another Result
 * @param result The Result
 * @param f The function returning a new Result
 * @returns Chained Result
 */
function flatMap<T, E, U>(result: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  if (result.tag === 'Ok') {
    return f(result.value);
  }
  return result;
}

/**
 * Map the error of an erroneous Result
 * @param result The Result
 * @param f The error mapping function
 * @returns New Result with transformed error
 */
function mapErr<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
  if (result.tag === 'Err') {
    return err(f(result.error));
  }
  return result;
}

/**
 * Unwrap the value of a successful Result
 * @param result The Result
 * @returns The value
 * @throws If Result is erroneous
 */
function unwrap<T, E>(result: Result<T, E>): T {
  if (result.tag === 'Err') {
    throw new Error('Called unwrap on Err');
  }
  return result.value;
}

/**
 * Unwrap the value or return a default
 * @param result The Result
 * @param defaultValue The default value
 * @returns The value or default
 */
function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  if (result.tag === 'Ok') {
    return result.value;
  }
  return defaultValue;
}

/**
 * Pattern match on a Result
 * @param result The Result
 * @param handlers Object with ok and err handlers
 * @returns Result of handler
 */
function match<T, E, R>(result: Result<T, E>, handlers: { ok: (value: T) => R; err: (error: E) => R }): R {
  if (result.tag === 'Ok') {
    return handlers.ok(result.value);
  }
  return handlers.err(result.error);
}

export { Result, ok, err, map, flatMap, mapErr, unwrap, unwrapOr, match };