# dependency-injector - Quarantine Review

**Package:** `packages/tools/dependency-injector.ts`
**Branch:** `quarantine/dependency-injector`
**Status:** Quarantine - pending review before merge to main

---

## What it does

Lightweight dependency injection container for agent services. Register service
factories by string token, resolve them by token. Singleton and transient
lifecycles, circular dependency detection, child containers. Zero dependencies.

### Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `Container` | class | Main DI container |
| `createContainer` | `(defs) => Container` | Convenience factory from a record |
| `ContainerError` | class | Thrown on misuse or circular deps |
| `Lifecycle` | `"singleton" \| "transient"` | Lifecycle type |
| `Factory<T>` | `(container: Container) => T` | Factory function type |

### Container methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `register` | `(token, factory, lifecycle?) => this` | Chainable. Default lifecycle: singleton |
| `resolve` | `(token) => T` | Throws on unknown token or circular dep |
| `has` | `(token) => boolean` | Check registration without resolving |
| `reset` | `(token) => this` | Evict singleton cache; no-op for transient |
| `unregister` | `(token) => this` | Remove registration entirely |
| `tokens` | `() => string[]` | List all registered tokens |
| `createChild` | `() => Container` | Inherit parent registrations, isolated overrides |

---

## Integration path

The container is intended as a service locator for the Eight agent core. Likely
consumers:

1. `packages/eight/agent.ts` - wire tool registry, memory store, and model
   provider through a container rather than direct imports.
2. `packages/daemon/` - register long-lived services (AgentPool, WebSocket
   server, auth layer) as singletons at process startup.
3. `packages/orchestration/` - child containers per worktree so sub-agents get
   scoped service instances without polluting the root container.

Wire-in steps when ready to promote:

1. Export from `packages/tools/index.ts`.
2. Create a root container in `packages/eight/agent.ts` or a new
   `packages/eight/container.ts` bootstrap file.
3. Replace ad-hoc module-level singletons with container registrations.
4. Pass the container (or child containers) down to sub-agents and tools.

---

## Usage

```ts
import { Container } from "./packages/tools/dependency-injector";

const c = new Container();

c.register("logger", () => ({ log: (m: string) => console.log(m) }), "singleton");
c.register("db", (c) => new Database(c.resolve("logger")), "singleton");
c.register("request-id", () => crypto.randomUUID(), "transient");

const db = c.resolve<Database>("db");        // created once, cached
const id1 = c.resolve<string>("request-id"); // new UUID each call
const id2 = c.resolve<string>("request-id"); // different UUID

// Child container - useful for per-session or per-worktree scope
const child = c.createChild();
child.register("db", (c) => new TestDatabase(c.resolve("logger")), "singleton");
```

---

## Design decisions

- **Zero deps.** No reflect-metadata, no decorators, no IoC framework.
- **String tokens.** Simple, debuggable, compatible with dynamic registration.
- **Circular detection.** Tracked with a resolving set; throws immediately with
  the offending token name.
- **Child containers.** Copy-on-write registrations - parent is never mutated.
- **Chainable register/reset/unregister.** Lets bootstrap code read as a fluent
  sequence.
- **No async factories.** Kept synchronous to avoid promise leakage in hot
  resolve paths. If async init is needed, register a lazy wrapper that caches
  its own promise.

---

## Files touched

- `packages/tools/dependency-injector.ts` - implementation (new)
- `quarantine/dependency-injector.md` - this file (new)

No existing files modified.

---

## Checklist before merging

- [ ] Decide on token convention (plain string vs Symbol vs typed token class)
- [ ] Consider adding async factory support if daemon startup needs it
- [ ] Wire into `packages/tools/index.ts`
- [ ] Add unit tests in `packages/tools/__tests__/dependency-injector.test.ts`
- [ ] Audit existing module-level singletons as migration candidates
