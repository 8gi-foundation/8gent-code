# Quarantine: null-object

**Status:** Quarantine - safe to wire in, no side effects
**File:** `packages/tools/null-object.ts`
**Lines:** ~130

## What it does

Three exports for safe null-chain patterns using ES Proxy and a wrapper class:

| Export | Purpose |
|--------|---------|
| `nullObject<T>()` | Returns a typed Proxy that never throws on any property access or function call |
| `isNullObject(value)` | Detects a null object proxy via internal Symbol sentinel |
| `Maybe<T>` | Class wrapping nullable with `.get()`, `.or()`, `.map()`, `.chain()` |
| `maybe(value)` | Factory shorthand for `new Maybe(value)` |

## Why

Deep optional chains appear constantly in agent code - config trees, partial API responses, tool results with missing fields. The standard pattern is defensive null checks at every step. This makes chains safe by default without the boilerplate.

## Usage

```ts
import { nullObject, maybe, isNullObject } from "../tools/null-object";

// Safe chain - never throws even if structure is completely absent
const obj = nullObject<Config>();
const val = obj.database.host.port(); // returns nullObject, no throw

// Maybe for nullable values
const name = maybe(user?.profile)
  .chain("displayName")
  .or("Anonymous");

// Detection
isNullObject(nullObject()); // true
isNullObject(null);         // false
isNullObject({});           // false
```

## Constraints

- `nullObject` Proxy coerces to `undefined` on primitive conversion - not `null`. Be aware when used in string interpolation or arithmetic.
- `Maybe.chain()` returns `Maybe(null)` on absence, not `nullObject`. The two patterns are complementary, not equivalent.
- No async support in `Maybe.map()` by design - keep it synchronous and composable.

## Not doing

- No `Option`/`Result` monad algebra (flatMap, fold, etc.) - use a dedicated fp-ts-style lib if needed
- No async Maybe - out of scope
- No runtime validation of T shape - this is null safety, not schema validation
