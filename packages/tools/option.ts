/**
 * Represents a value that is present.
 * @template T The type of the value.
 */
class Some<T> {
  constructor(private value: T) {}

  /**
   * Applies a function to the value and returns a new Option with the result.
   * @param f The function to apply.
   * @returns A new Option with the transformed value.
   */
  map<U>(f: (value: T) => U): Option<U> {
    return new Some(f(this.value));
  }

  /**
   * Applies a function that returns an Option to the value and returns the result.
   * @param f The function to apply.
   * @returns The resulting Option.
   */
  flatMap<U>(f: (value: T) => Option<U>): Option<U> {
    return f(this.value);
  }

  /**
   * Filters the value based on a predicate.
   * @param predicate The predicate to apply.
   * @returns This Option if the predicate is true, otherwise None.
   */
  filter(predicate: (value: T) => boolean): Option<T> {
    return predicate(this.value) ? this : None.instance;
  }

  /**
   * Returns the value if present, otherwise returns the default value.
   * @param defaultValue The default value to return if none.
   * @returns The value or the default.
   */
  getOrElse(defaultValue: T): T {
    return this.value;
  }

  /**
   * Checks if this is a Some instance.
   * @returns True if this is Some, false otherwise.
   */
  isSome(): this is Some<T> {
    return true;
  }

  /**
   * Checks if this is a None instance.
   * @returns True if this is None, false otherwise.
   */
  isNone(): this is None {
    return false;
  }
}

/**
 * Represents the absence of a value.
 */
class None {
  static instance: None = new None();

  private constructor() {}

  /**
   * Applies a function to the value and returns a new Option with the result.
   * @param f The function to apply.
   * @returns A new Option with the transformed value.
   */
  map<U>(f: (value: never) => U): Option<U> {
    return None.instance;
  }

  /**
   * Applies a function that returns an Option to the值 and returns the result.
   * @param f The function to apply.
   * @returns The resulting Option.
   */
  flatMap<U>(f: (value: never) => Option<U>): Option<U> {
    return None.instance;
  }

  /**
   * Filters the value based on a predicate.
   * @param predicate The predicate to apply.
   * @returns This Option if the predicate is true, otherwise None.
   */
  filter(predicate: (value: never) => boolean): Option<never> {
    return None.instance;
  }

  /**
   * Returns the value if present, otherwise returns the default value.
   * @param defaultValue The default value to return if none.
   * @returns The value or the default.
   */
  getOrElse(defaultValue: never): never {
    return defaultValue;
  }

  /**
   * Checks if this is a Some instance.
   * @returns True if this is Some, false otherwise.
   */
  isSome(): this is Some<never> {
    return false;
  }

  /**
   * Checks if this is a None instance.
   * @returns True if this is None, false otherwise.
   */
  isNone(): this is None {
    return true;
  }
}

type Option<T> = Some<T> | None;

/**
 * Creates an Option containing the given value.
 * @param value The value to wrap.
 * @returns An Option containing the value.
 */
function some<T>(value: T): Some<T> {
  return new Some(value);
}

/**
 * Creates an empty Option.
 * @returns An empty Option.
 */
function none(): None {
  return None.instance;
}

/**
 * Creates an Option from a nullable value.
 * @param val The value to wrap.
 * @returns An Option containing the value if not null, otherwise None.
 */
function fromNullable<T>(val: T | null | undefined): Option<T> {
  return val == null ? none() : some(val);
}

/**
 * Checks if the Option is a Some instance.
 * @param option The Option to check.
 * @returns True if it is a Some, false otherwise.
 */
function isSome<T>(option: Option<T>): option is Some<T> {
  return option.isSome();
}

/**
 * Checks if the Option is a None instance.
 * @param option The Option to check.
 * @returns True if it is a None, false otherwise.
 */
function isNone<T>(option: Option<T>): option is None {
  return option.isNone();
}

export { Some, None, Option, some, none, fromNullable, isSome, isNone };