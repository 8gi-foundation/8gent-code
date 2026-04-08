# Quarantine: dependency-injector-v2

**Status:** quarantine - awaiting review
**File:** `packages/tools/dependency-injector-v2.ts`
**Size:** ~130 lines

## What it does

Token-based dependency injection container. Decorator-free. All wiring is explicit via factory functions, so it works without TypeScript `experimentalDecorators` and has zero runtime metadata overhead.

## API

```ts
import { createContainer, createToken } from './packages/tools/dependency-injector-v2';

const DB_TOKEN    = createToken<Database>('Database');
const REPO_TOKEN  = createToken<UserRepo>('UserRepo');

const container = createContainer();

container.bindValue(DB_TOKEN, new Database(':memory:'));
container.bindSingleton(REPO_TOKEN, c => new UserRepo(c.get(DB_TOKEN)));

const repo = container.get(REPO_TOKEN); // UserRepo, created once
```

## Methods

| Method | Description |
|--------|-------------|
| `bind(token, factory)` | Transient - new instance per `get()` |
| `bindSingleton(token, factory)` | Singleton - created once, reused |
| `bindValue(token, value)` | Pre-existing value, treated as singleton |
| `get(token)` | Resolve token; throws if unbound |
| `has(token)` | Check binding exists (walks parent chain) |
| `createScope()` | Child container that inherits parent bindings |
| `reset()` | Clear singleton instances in this container |
| `registeredTokens()` | List token descriptions in this container |

## Design decisions

- **No decorators.** Works with `"experimentalDecorators": false`. Explicit factories over magic reflection.
- **Token type.** `Token<T>` is a branded symbol - type-safe at compile time, no string collision risk.
- **Scoped containers.** `createScope()` creates a child container. Child overrides shadow the parent. Parent singletons remain shared.
- **No circular detection.** Factory functions are called synchronously. Circular dependencies will stack-overflow naturally. Add detection later if needed.

## Exit criteria

- [ ] Unit tests covering bind/singleton/value/scope/has/reset
- [ ] Integration test wiring 3+ real packages (e.g. memory + orchestration + tools)
- [ ] Confirm zero performance regression on agent loop startup
- [ ] Decision: promote to `packages/tools/index.ts` exports or keep as standalone utility
