# Quarantine: context-store

**Package:** `packages/tools/context-store.ts`
**Status:** Quarantine - review before wiring into agent tools

## What It Does

Request-scoped context propagation using Node.js `AsyncLocalStorage`. Lets any code in an async call tree read and write typed context values without passing them through every function signature. Nested scopes inherit parent values; inner writes do not bleed upward.

## Exported API

| Export | Type | Description |
|--------|------|-------------|
| `ContextStore` | class | Core store - `run`, `get`, `set`, `getAll`, `has` |
| `contextStore` | `ContextStore` | Singleton for general use |
| `createContext` | `(namespace: string) => NamespacedContext` | Namespaced accessor, isolates keys by prefix |

### `ContextStore` methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `run` | `(context, fn) => T` | Opens new scope; merges on top of parent |
| `get` | `(key) => T \| undefined` | Returns undefined outside a scope |
| `set` | `(key, value) => void` | No-op outside a scope |
| `getAll` | `() => Record<string, unknown>` | Snapshot of all keys in current scope |
| `has` | `(key) => boolean` | Key existence check |

### `createContext` namespaced accessor

Same surface as `ContextStore` but all keys are prefixed with `namespace:`. Prevents collisions between subsystems sharing the same storage.

## Design Decisions

- Single `AsyncLocalStorage<Map>` for the process. No per-instance storage.
- Nesting is copy-on-entry: parent Map is cloned on each `run()`. Inner writes are isolated.
- `createContext` is a thin namespace wrapper over the singleton - not a separate storage context.
- No external dependencies. Node built-in only (`async_hooks`).

## Use Cases

```ts
import { contextStore, createContext } from "./packages/tools/context-store";

// Basic request scope
contextStore.run({ requestId: "req-123", userId: "usr-456" }, async () => {
  const id = contextStore.get<string>("requestId"); // "req-123"
  await someDeepFunction(); // still accessible here
});

// Namespaced context
const traceCtx = createContext("trace");

contextStore.run({}, () => {
  traceCtx.set("spanId", "span-abc");
  traceCtx.get("spanId"); // "span-abc"
  traceCtx.getAll();      // { spanId: "span-abc" }
});

// Nested scopes - child inherits, parent is unchanged
contextStore.run({ env: "prod" }, () => {
  contextStore.run({ env: "test", feature: "x" }, () => {
    contextStore.get("env");     // "test"
    contextStore.get("feature"); // "x"
  });
  contextStore.get("env");       // "prod" - unchanged
  contextStore.has("feature");   // false
});
```

## Quarantine Checklist

- [ ] Unit tests written and passing
- [ ] Confirmed behavior under Bun (AsyncLocalStorage compatibility)
- [ ] Reviewed for use in daemon/vessel request context propagation
- [ ] Considered typed generic support in `createContext<T>(namespace)`
- [ ] Integrated into agent tool registry if needed
