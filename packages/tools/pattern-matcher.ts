/**
 * pattern-matcher.ts
 * Rust-style pattern matching for TypeScript values.
 *
 * Usage:
 *   match(value)
 *     .with("foo", () => "literal match")
 *     .with((v): v is number => typeof v === "number", (n) => n * 2)
 *     .with((v) => v === null, () => "null guard")
 *     .otherwise(() => "default")
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TypeGuard<T, N extends T> = (value: T) => value is N;
type Predicate<T> = (value: T) => boolean;
type Literal = string | number | boolean | null | undefined;

type Pattern<T> =
  | Literal
  | TypeGuard<T, T extends object ? T : never>
  | Predicate<T>
  | typeof __;

type Handler<T, R> = (value: T) => R;

interface MatchChain<T, R> {
  /** Match a literal value, type guard, predicate, or wildcard. */
  with<N extends T>(pattern: TypeGuard<T, N>, handler: Handler<N, R>): MatchChain<T, R>;
  with(pattern: Literal | Predicate<T> | typeof __, handler: Handler<T, R>): MatchChain<T, R>;
  /** Fallback executed if no pattern matched. Returns the final result. */
  otherwise(handler: Handler<T, R>): R;
  /** Run without a fallback - throws if nothing matched. */
  exhaustive(): R;
}

// ---------------------------------------------------------------------------
// Wildcard sentinel
// ---------------------------------------------------------------------------

const __ = Symbol("wildcard");
export { __ };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isLiteral(p: unknown): p is Literal {
  const t = typeof p;
  return p === null || p === undefined || t === "string" || t === "number" || t === "boolean";
}

function matchesPattern<T>(value: T, pattern: Pattern<T>): boolean {
  if (pattern === __) return true;
  if (isLiteral(pattern)) return value === (pattern as unknown);
  if (typeof pattern === "function") return (pattern as Predicate<T>)(value);
  return false;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

class MatchChainImpl<T, R> implements MatchChain<T, R> {
  private readonly _value: T;
  private _result: { matched: true; value: R } | { matched: false } = { matched: false };

  constructor(value: T) {
    this._value = value;
  }

  with(pattern: Pattern<T>, handler: Handler<T, R>): this {
    if (!this._result.matched && matchesPattern(this._value, pattern)) {
      this._result = { matched: true, value: handler(this._value) };
    }
    return this;
  }

  otherwise(handler: Handler<T, R>): R {
    if (this._result.matched) return this._result.value;
    return handler(this._value);
  }

  exhaustive(): R {
    if (this._result.matched) return this._result.value;
    throw new Error(
      `[pattern-matcher] No pattern matched value: ${JSON.stringify(this._value)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Begin a pattern-match expression.
 *
 * @example
 * const label = match(status)
 *   .with("ok", () => "All good")
 *   .with("error", () => "Something broke")
 *   .with((s): s is string => s.startsWith("warn"), (s) => `Warning: ${s}`)
 *   .with(__, () => "Unknown")
 *   .exhaustive();
 */
export function match<T>(value: T): MatchChain<T, never> {
  return new MatchChainImpl<T, never>(value) as unknown as MatchChain<T, never>;
}
