# typed-map

**Status:** Quarantine - under evaluation
**Package:** `packages/tools/typed-map.ts`
**Lines:** ~130

## What it is

`TypedMap` is a `Map` variant with per-key type safety using typed tokens. Instead of a generic `Map<string, unknown>`, each key is a `Token<T>` that carries its value type. `get(token)` returns `T`, not `unknown`. No casts, no runtime type checks - type safety flows from the token.

## Core API

```ts
import { TypedMap, createToken } from "./packages/tools/typed-map.ts";

const nameToken  = createToken<string>("name");
const countToken = createToken<number>("count");
const flagToken  = createToken<boolean>("flag");

const map = new TypedMap();
map.set(nameToken, "eight");        // OK - string
map.set(countToken, 42);            // OK - number
// map.set(nameToken, 42);          // TypeScript error - wrong type

map.get(nameToken);                 // string | undefined
map.getOrThrow(countToken);         // number (throws if missing)
map.has(flagToken);                 // false
map.delete(nameToken);              // true
map.size;                           // 1
map.clear();
```

## Why it exists

Heterogeneous key-value stores are common in agent systems (session context, tool outputs, config bags). The normal approach forces `as T` casts everywhere. Token-keyed maps eliminate that by encoding the type at token creation time - not at use time.

## Token identity

Each `createToken<T>(name)` call returns a unique token via `Symbol(name)`. Two tokens with the same name are distinct keys. This makes accidental key collision impossible.

## Snapshot

```ts
const snap = map.snapshot({ nameToken, countToken });
// { nameToken: string | undefined, countToken: number | undefined }
```

Useful for serialization or passing subsets to sub-agents.

## Trade-offs

- Token objects must be passed around (not reconstructible from a string key alone)
- No iteration with type information - track tokens externally if you need to iterate typed
- Snapshot type inference requires TypeScript 4.7+

## Promotion criteria

- Used in at least 2 packages (session context or tool output store)
- Reduces `as T` casts in consumer code
- No runtime overhead vs plain `Map` on benchmarks
