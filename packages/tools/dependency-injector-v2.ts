/**
 * dependency-injector-v2.ts
 *
 * Token-based DI container. Decorator-free. Auto-wiring via factory functions.
 * Supports singleton, transient, and value bindings. Scoped child containers.
 */

export type Token<T = unknown> = symbol & { __type?: T };

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}

type Factory<T> = (container: Container) => T;

interface Binding<T> {
  factory: Factory<T>;
  singleton: boolean;
  instance?: T;
}

export class Container {
  private bindings = new Map<Token, Binding<unknown>>();
  private parent?: Container;

  constructor(parent?: Container) {
    this.parent = parent;
  }

  /**
   * Bind a token to a transient factory.
   * A new instance is created on every get().
   */
  bind<T>(token: Token<T>, factory: Factory<T>): this {
    this.bindings.set(token, { factory: factory as Factory<unknown>, singleton: false });
    return this;
  }

  /**
   * Bind a token to a singleton factory.
   * The instance is created once and reused on subsequent get() calls.
   */
  bindSingleton<T>(token: Token<T>, factory: Factory<T>): this {
    this.bindings.set(token, { factory: factory as Factory<unknown>, singleton: true });
    return this;
  }

  /**
   * Bind a token to a pre-existing value.
   * Equivalent to bindSingleton with a factory that returns the value.
   */
  bindValue<T>(token: Token<T>, value: T): this {
    this.bindings.set(token, {
      factory: () => value,
      singleton: true,
      instance: value,
    });
    return this;
  }

  /**
   * Resolve a token. Throws if no binding is found in this container or any parent.
   */
  get<T>(token: Token<T>): T {
    const binding = this.bindings.get(token) as Binding<T> | undefined;

    if (binding) {
      if (binding.singleton) {
        if (!("instance" in binding) || binding.instance === undefined) {
          binding.instance = binding.factory(this);
        }
        return binding.instance as T;
      }
      return binding.factory(this);
    }

    if (this.parent) {
      return this.parent.get(token);
    }

    const description = token.description ?? "(unknown)";
    throw new Error(`No binding found for token: ${description}`);
  }

  /**
   * Check whether a binding exists for the given token (including parent containers).
   */
  has<T>(token: Token<T>): boolean {
    if (this.bindings.has(token)) return true;
    return this.parent?.has(token) ?? false;
  }

  /**
   * Create a child scope. Bindings in the child override the parent.
   * Singletons in the parent remain shared; new singletons in the child are local.
   */
  createScope(): Container {
    return new Container(this);
  }

  /**
   * Release all singleton instances in this container.
   * Does not affect the parent container.
   */
  reset(): void {
    for (const [, binding] of this.bindings) {
      if (binding.singleton && binding.instance !== undefined) {
        delete binding.instance;
      }
    }
  }

  /**
   * Return all token descriptions registered in this container (not parent).
   */
  registeredTokens(): string[] {
    return Array.from(this.bindings.keys()).map(t => t.description ?? "(unknown)");
  }
}

/**
 * Create a new root container.
 */
export function createContainer(): Container {
  return new Container();
}
