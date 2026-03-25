/**
 * Typed token registry for dependency injection.
 * Provides a provide/inject pattern with scoped resolution and parent fallback.
 */

// ------------------------------------------------------------
// Token
// ------------------------------------------------------------

/**
 * A typed token used as a key in the registry.
 * Each token carries a unique symbol to prevent collisions.
 */
export interface Token<T> {
  readonly symbol: symbol;
  readonly description: string;
  readonly _type?: T; // phantom type - never assigned at runtime
}

/**
 * Create a typed token with an optional description.
 *
 * @example
 * const LoggerToken = createToken<Logger>("Logger");
 */
export function createToken<T>(description: string): Token<T> {
  return {
    symbol: Symbol(description),
    description,
  };
}

// ------------------------------------------------------------
// TokenRegistry
// ------------------------------------------------------------

type RegistryMap = Map<symbol, unknown>;

export class TokenRegistry {
  private readonly _store: RegistryMap = new Map();
  private readonly _parent: TokenRegistry | null;

  constructor(parent: TokenRegistry | null = null) {
    this._parent = parent;
  }

  /**
   * Register a value for a token in this scope.
   * Overwrites any existing value for the same token in this scope.
   */
  provide<T>(token: Token<T>, value: T): void {
    this._store.set(token.symbol, value);
  }

  /**
   * Retrieve the value for a token.
   * Falls back to the parent registry if the token is not in this scope.
   * Throws if the token is not found anywhere in the chain.
   */
  inject<T>(token: Token<T>): T {
    if (this._store.has(token.symbol)) {
      return this._store.get(token.symbol) as T;
    }
    if (this._parent !== null) {
      return this._parent.inject(token);
    }
    throw new Error(
      `TokenRegistry: no provider found for token "${token.description}". ` +
        `Did you forget to call provide()?`
    );
  }

  /**
   * Check if a token has a value in this scope or any ancestor.
   */
  has<T>(token: Token<T>): boolean {
    if (this._store.has(token.symbol)) return true;
    if (this._parent !== null) return this._parent.has(token);
    return false;
  }

  /**
   * Check if a token has a value only in this specific scope (not ancestors).
   */
  hasOwn<T>(token: Token<T>): boolean {
    return this._store.has(token.symbol);
  }

  /**
   * Remove a token from this scope only.
   * Parent scopes are unaffected.
   */
  delete<T>(token: Token<T>): boolean {
    return this._store.delete(token.symbol);
  }

  /**
   * Clear all tokens from this scope.
   * Parent scopes are unaffected.
   */
  clear(): void {
    this._store.clear();
  }

  /**
   * Create a child scope that falls back to this registry for missing tokens.
   */
  createScope(): TokenRegistry {
    return new TokenRegistry(this);
  }

  /**
   * Number of tokens registered in this scope (not counting ancestors).
   */
  get size(): number {
    return this._store.size;
  }
}

// ------------------------------------------------------------
// Root registry singleton (optional convenience export)
// ------------------------------------------------------------

/** Global root registry. Use createToken + root.provide/inject for simple cases. */
export const root = new TokenRegistry();
