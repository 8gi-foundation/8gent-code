/**
 * TypedMap - Map with per-key type safety via token pattern.
 *
 * Usage:
 *   const nameToken = createToken<string>("name");
 *   const countToken = createToken<number>("count");
 *
 *   const map = new TypedMap();
 *   map.set(nameToken, "eight");
 *   map.set(countToken, 42);
 *
 *   map.get(nameToken); // string
 *   map.get(countToken); // number
 */

// Branded token type - the phantom type T carries the value type.
declare const __brand: unique symbol;
type Brand<B> = { readonly [__brand]: B };

export type Token<T> = Brand<T> & {
  readonly name: string;
  readonly id: symbol;
};

/**
 * Create a typed token. Each call returns a unique token even if names match.
 */
export function createToken<T>(name: string): Token<T> {
  return {
    name,
    id: Symbol(name),
  } as Token<T>;
}

/**
 * TypedMap provides per-key type safety using typed tokens.
 * Values are stored internally as `unknown` and cast via token types.
 */
export class TypedMap {
  private readonly store = new Map<symbol, unknown>();

  /**
   * Set a value for the given token. Type is enforced by the token.
   */
  set<T>(token: Token<T>, value: T): this {
    this.store.set(token.id, value);
    return this;
  }

  /**
   * Get the value for the given token. Returns undefined if not set.
   */
  get<T>(token: Token<T>): T | undefined {
    return this.store.get(token.id) as T | undefined;
  }

  /**
   * Get the value for the given token, throwing if not present.
   */
  getOrThrow<T>(token: Token<T>): T {
    if (!this.store.has(token.id)) {
      throw new Error(`TypedMap: key "${token.name}" not found`);
    }
    return this.store.get(token.id) as T;
  }

  /**
   * Check if a token has been set.
   */
  has<T>(token: Token<T>): boolean {
    return this.store.has(token.id);
  }

  /**
   * Delete a token's value. Returns true if it existed.
   */
  delete<T>(token: Token<T>): boolean {
    return this.store.delete(token.id);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Number of entries currently stored.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Iterate over all raw [symbol, value] pairs.
   * For typed iteration, track your tokens externally.
   */
  entries(): IterableIterator<[symbol, unknown]> {
    return this.store.entries();
  }

  /**
   * Create a snapshot of values for a set of known tokens.
   * Returns a plain object keyed by token name.
   */
  snapshot<T extends Record<string, Token<unknown>>>(
    tokens: T
  ): { [K in keyof T]: T[K] extends Token<infer V> ? V | undefined : never } {
    const result = {} as Record<string, unknown>;
    for (const [key, token] of Object.entries(tokens)) {
      result[key] = this.get(token as Token<unknown>);
    }
    return result as {
      [K in keyof T]: T[K] extends Token<infer V> ? V | undefined : never;
    };
  }
}
