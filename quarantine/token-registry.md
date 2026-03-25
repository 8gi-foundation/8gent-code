# Quarantine: token-registry

**Status:** quarantine - awaiting integration review

## What

Typed token registry for dependency injection (`packages/tools/token-registry.ts`).

## API

```ts
import { createToken, TokenRegistry } from "../packages/tools/token-registry";

const LoggerToken = createToken<Logger>("Logger");

const registry = new TokenRegistry();
registry.provide(LoggerToken, new ConsoleLogger());

const logger = registry.inject(LoggerToken); // typed as Logger
```

## Scoped resolution

Child scopes inherit from parent. Override per-scope without affecting the parent.

```ts
const child = registry.createScope();
child.provide(LoggerToken, new SilentLogger()); // parent still has ConsoleLogger
```

## Exports

| Export | Purpose |
|--------|---------|
| `Token<T>` | Interface - typed key with unique symbol |
| `createToken<T>(description)` | Factory - create a typed token |
| `TokenRegistry` | Class - provide, inject, has, hasOwn, delete, clear, createScope |
| `root` | Singleton root registry for simple use cases |

## Why quarantine

- Pattern is sound and low-risk (110 lines, no deps)
- Needs a decision on whether it replaces any existing DI patterns in the codebase before wiring in
- No existing packages import it yet

## Integration checklist

- [ ] Review existing DI patterns in packages/eight/ and packages/orchestration/
- [ ] Wire into packages/eight/agent.ts if replacing constructor injection
- [ ] Add tests in packages/tools/__tests__/token-registry.test.ts
- [ ] Remove quarantine status once wired
