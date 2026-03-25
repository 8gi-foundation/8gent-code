# fn-overload

**Status:** Quarantine - not wired into main agent loop.

## What it does

Runtime function overloading via predicate-based dispatch. Build a single function from ordered `when(predicate, handler)` clauses. The first matching predicate runs its handler. An optional `otherwise(handler)` acts as a default. Without a default, unmatched calls throw `OverloadNoMatchError`.

## File

`packages/tools/fn-overload.ts`

## API

```ts
import { overload } from "./packages/tools/fn-overload";

const handle = overload<string | number | boolean, string>()
  .when((x): x is string => typeof x === "string", (s) => `string: ${s}`)
  .when((x): x is number => typeof x === "number", (n) => `number: ${n}`)
  .otherwise((x) => `other: ${String(x)}`)
  .build();

handle("hi");   // "string: hi"
handle(7);      // "number: 7"
handle(true);   // "other: true"
```

## Design decisions

- **Ordered clauses** - insertion order matches, no priority weights. Predictable.
- **Type-narrowing predicates** - TypeScript type guards work as `when()` predicates.
- **No magic** - no reflection, no decorator magic, no runtime type registry. Pure predicate matching.
- **`OverloadNoMatchError`** - includes the unmatched value and its type in the message.
- **Builder pattern** - `build()` compiles a closed-over function. Re-use the builder to create multiple variants.

## Use cases inside 8gent

- Tool dispatch: match on tool call name or argument shape without long if/else chains.
- Command routing: route CLI args to handlers by type or pattern.
- Adapter layers: normalize heterogeneous API responses before feeding into agent context.

## Size

~120 lines, zero dependencies.
