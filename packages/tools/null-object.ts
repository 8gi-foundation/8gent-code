/**
 * null-object.ts
 *
 * Null Object pattern via ES Proxy. Creates safe chains that never throw -
 * any property access or function call on a nullObject returns another nullObject.
 *
 * Useful for: optional config trees, partial API responses, safe chaining on
 * possibly-undefined values without defensive null checks everywhere.
 */

// Sentinel symbol to detect null objects internally
const NULL_OBJECT = Symbol("NULL_OBJECT");

/**
 * Creates a recursive Proxy that:
 * - Returns nullObject<any> for any property access (never throws)
 * - Returns nullObject<any> for any function call (no-op, never throws)
 * - Returns undefined for primitive coercion (valueOf, toString)
 * - Reports as null object via Symbol check
 */
function createNullProxy(): any {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === NULL_OBJECT) return true;
      if (prop === Symbol.toPrimitive) return () => undefined;
      if (prop === "valueOf") return () => undefined;
      if (prop === "toString") return () => "";
      if (prop === "toJSON") return () => null;
      if (prop === Symbol.iterator) return function* () {};
      return createNullProxy();
    },
    apply() {
      return createNullProxy();
    },
    set() {
      return true; // silent no-op
    },
    has() {
      return false;
    },
    deleteProperty() {
      return true;
    },
    construct() {
      return createNullProxy();
    },
  };

  // Must be callable to support apply trap
  const target = function () {};
  return new Proxy(target, handler);
}

/**
 * Returns a typed null object Proxy.
 * Every property access and function call returns another nullObject.
 * Safe to chain indefinitely - never throws.
 *
 * @example
 * const obj = nullObject<{ user: { name: string } }>();
 * obj.user.name       // => nullObject (no throw)
 * obj.user.name()     // => nullObject (no throw)
 */
export function nullObject<T = unknown>(): T {
  return createNullProxy() as T;
}

/**
 * Returns true if the given value is a nullObject proxy.
 */
export function isNullObject(value: unknown): boolean {
  if (value == null) return false;
  try {
    return (value as any)[NULL_OBJECT] === true;
  } catch {
    return false;
  }
}

/**
 * Maybe<T> - wraps a nullable value with safe chaining.
 * If value is null/undefined, all property accesses delegate to nullObject.
 * If value exists, property accesses return Maybe-wrapped results.
 *
 * .get() unwraps the value (returns T | null).
 * .or(fallback) returns T or the fallback.
 * .map(fn) transforms the value if present.
 */
export class Maybe<T> {
  private readonly _value: T | null | undefined;

  constructor(value: T | null | undefined) {
    this._value = value;
  }

  /** True if value is present (not null/undefined). */
  get hasValue(): boolean {
    return this._value != null;
  }

  /** Unwrap the value. Returns null if not present. */
  get(): T | null {
    return this._value ?? null;
  }

  /** Return the value or a fallback if not present. */
  or(fallback: T): T {
    return this._value ?? fallback;
  }

  /**
   * Transform the value if present. Returns Maybe<U>.
   * If value is absent, returns Maybe(null) without calling fn.
   */
  map<U>(fn: (value: T) => U): Maybe<U> {
    if (this._value == null) return new Maybe<U>(null);
    return new Maybe<U>(fn(this._value));
  }

  /**
   * Safe property chain. Returns nullObject<any> if value is absent,
   * otherwise returns the property value wrapped in Maybe.
   */
  chain<K extends keyof T>(key: K): Maybe<T[K]> {
    if (this._value == null) return new Maybe<T[K]>(null);
    return new Maybe<T[K]>(this._value[key]);
  }

  toString(): string {
    return this._value != null ? String(this._value) : "Maybe(empty)";
  }
}

/**
 * Convenience factory for Maybe<T>.
 *
 * @example
 * const name = maybe(user)
 *   .chain("profile")
 *   .chain("displayName")
 *   .or("Anonymous");
 */
export function maybe<T>(value: T | null | undefined): Maybe<T> {
  return new Maybe<T>(value);
}
