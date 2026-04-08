/**
 * Lightweight dependency injection container for agent services.
 * Supports singleton and transient lifecycles. Zero dependencies.
 */

export type Lifecycle = "singleton" | "transient";
export type Factory<T> = (container: Container) => T;

interface Registration<T = unknown> {
  factory: Factory<T>;
  lifecycle: Lifecycle;
  instance?: T;
}

export class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerError";
  }
}

/**
 * DI container. Register services by string token, resolve by token.
 *
 * @example
 * const c = new Container();
 * c.register("logger", () => new Logger(), "singleton");
 * c.register("db", (c) => new Database(c.resolve("logger")), "singleton");
 * const db = c.resolve<Database>("db");
 */
export class Container {
  private registry = new Map<string, Registration>();
  private resolving = new Set<string>();

  register<T>(token: string, factory: Factory<T>, lifecycle: Lifecycle = "singleton"): this {
    if (!token || typeof token !== "string") {
      throw new ContainerError("token must be a non-empty string");
    }
    if (typeof factory !== "function") {
      throw new ContainerError(`factory for "${token}" must be a function`);
    }
    this.registry.set(token, { factory: factory as Factory<unknown>, lifecycle });
    return this;
  }

  resolve<T>(token: string): T {
    const reg = this.registry.get(token);
    if (!reg) {
      const known = [...this.registry.keys()].join(", ");
      throw new ContainerError(`"${token}" is not registered. Known: [${known}]`);
    }
    if (reg.lifecycle === "singleton" && reg.instance !== undefined) {
      return reg.instance as T;
    }
    if (this.resolving.has(token)) {
      throw new ContainerError(`Circular dependency detected while resolving "${token}"`);
    }
    this.resolving.add(token);
    try {
      const instance = reg.factory(this) as T;
      if (reg.lifecycle === "singleton") reg.instance = instance;
      return instance;
    } finally {
      this.resolving.delete(token);
    }
  }

  has(token: string): boolean {
    return this.registry.has(token);
  }

  reset(token: string): this {
    const reg = this.registry.get(token);
    if (reg) delete reg.instance;
    return this;
  }

  unregister(token: string): this {
    this.registry.delete(token);
    return this;
  }

  tokens(): string[] {
    return [...this.registry.keys()];
  }

  createChild(): Container {
    const child = new Container();
    for (const [token, reg] of this.registry.entries()) {
      child.registry.set(token, { ...reg });
    }
    return child;
  }
}

export function createContainer(
  defs: Record<string, { factory: Factory<unknown>; lifecycle?: Lifecycle }>
): Container {
  const c = new Container();
  for (const [token, def] of Object.entries(defs)) {
    c.register(token, def.factory, def.lifecycle ?? "singleton");
  }
  return c;
}
