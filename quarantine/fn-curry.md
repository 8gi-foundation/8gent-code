# Quarantine: fn-curry

**Status:** Quarantined - pending integration review
**File:** `packages/tools/fn-curry.ts`
**Added:** 2026-03-25

## What It Does

Provides five functional composition utilities:

| Export | Purpose |
|--------|---------|
| `curry(fn)` | Auto-curries a function of fixed arity. Accumulates args until `fn.length` is met, then calls. |
| `partial(fn, ...args)` | Pre-fills leading arguments. Returns a function awaiting the rest. |
| `partialRight(fn, ...args)` | Pre-fills trailing arguments. Returns a function awaiting the head. |
| `flip(fn)` | Swaps the first two arguments. Useful for adapting callback/comparator signatures. |
| `negate(fn)` | Returns a predicate that is the boolean inverse of `fn`. |

## Motivation

Functional pipelines across the agent, orchestration, and validation packages
repeatedly reconstruct these patterns inline. A single shared module removes
the duplication and gives consistent, well-typed behavior.

## Usage Examples

```ts
import { curry, partial, partialRight, flip, negate } from "../packages/tools/fn-curry";

// curry
const add = curry((a: number, b: number) => a + b);
add(1)(2);   // 3

// partial
const double = partial((a: number, b: number) => a * b, 2);
double(5);   // 10

// partialRight
const halve = partialRight((a: number, b: number) => a / b, 2);
halve(10);   // 5

// flip
const sub = (a: number, b: number) => a - b;
flip(sub)(3, 10);  // 7

// negate
const isEven = (n: number) => n % 2 === 0;
[1, 2, 3, 4].filter(negate(isEven));  // [1, 3]
```

## Integration Notes

- Zero dependencies. No imports from other packages.
- All functions preserve `ReturnType` generics for downstream type inference.
- `curry` uses `fn.length` - variadic functions (rest params) will have arity 0
  and will pass through immediately. Wrap with an explicit arity function if needed.
- No side effects. Safe to tree-shake.

## Promotion Checklist

- [ ] Unit tests added under `packages/tools/__tests__/fn-curry.test.ts`
- [ ] Export added to `packages/tools/index.ts`
- [ ] Referenced in at least one agent/orchestration callsite
- [ ] Reviewed for edge cases: 0-arity functions, single-arg currying
