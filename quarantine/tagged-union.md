# tagged-union

**Tool:** `packages/tools/tagged-union.ts`
**Status:** quarantine

## Description

Discriminated union helpers for TypeScript. TypeScript's type system supports
discriminated unions natively, but constructing variants, pattern matching
exhaustively, and narrowing with type guards all require repetitive boilerplate.
This module provides three thin abstractions - `createUnion`, `match`, and
`isVariant` - in a zero-dependency, ~150-line file.

## API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `createUnion` | `<U>() => VariantConstructors<U>` | Build typed variant constructors via Proxy |
| `match` | `(value, handlers) => R` | Exhaustive pattern match - TypeScript enforces all variants are handled |
| `matchPartial` | `(value, { ...handlers, _: fallback }) => R` | Partial match with required fallback for unhandled variants |
| `isVariant` | `(value, variant) => value is Extract<U, {type: K}>` | Narrow a union to a specific variant |

### Type Utilities

| Type | Purpose |
|------|---------|
| `Variant<T, P>` | Build a single variant type from tag + payload |
| `UnionOf<D>` | Derive a full union type from a definition map |
| `Handlers<U, R>` | Handlers map type for exhaustive matching |

## Usage

```ts
import { createUnion, match, isVariant } from '../../packages/tools/tagged-union';

type Result<T> =
  | { type: "ok"; value: T }
  | { type: "err"; error: string }
  | { type: "pending" };

const Result = createUnion<Result<number>>();

const r = Result.ok({ value: 42 });
const e = Result.err({ error: "not found" });

// exhaustive match
const label = match(r, {
  ok:      ({ value }) => `value=${value}`,
  err:     ({ error }) => `error: ${error}`,
  pending: () => "loading...",
});

// type guard
if (isVariant(r, "ok")) {
  console.log(r.value); // narrowed
}
```

## Integration Path

1. **Immediate** - import directly anywhere discriminated unions are constructed:
   ```ts
   import { createUnion, match, isVariant } from '../../packages/tools/tagged-union';
   ```
2. **Agent tool results** - `packages/eight/tools.ts` returns tool results as
   `{ type: "success" | "error" | "abort"; ... }`. Replace ad-hoc object literals
   with `createUnion` constructors for consistency.
3. **Re-export** - add to `packages/tools/index.ts` once usage is confirmed in at
   least one production callsite.

## Notes

- No external dependencies.
- All functions are pure. `createUnion` uses a `Proxy` so no variant list is
  needed - any key becomes a valid constructor at runtime.
- Variant objects are frozen on construction.
- `match` throws at runtime if a handler is missing - catches misconfigured
  unions that TypeScript cannot catch (e.g. values from external JSON).
