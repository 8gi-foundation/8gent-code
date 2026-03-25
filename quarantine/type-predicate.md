# type-predicate

**Status:** Quarantine - pending integration review
**Package:** `packages/tools/type-predicate.ts`
**Size:** ~130 lines

## What It Does

Composable type predicate builders. A single `is` export with primitive checkers and higher-order combinators for building complex runtime type guards.

## API

### Primitives

```ts
is.string(v)    // v is string
is.number(v)    // v is number (NaN-safe)
is.boolean(v)   // v is boolean
is.bigint(v)    // v is bigint
is.symbol(v)    // v is symbol
is.null(v)      // v is null
is.undefined(v) // v is undefined
is.function(v)  // v is function
is.object(v)    // v is Record<string, unknown> (non-array, non-null)
is.array(v)     // v is unknown[]
```

### Combinators

```ts
// Every element matches predicate
is.arrayOf(is.string)(["a", "b"])           // true

// All shape keys match their predicates
is.objectOf({ name: is.string, age: is.number })({ name: "Eight", age: 1 }) // true

// Any predicate matches
is.union(is.string, is.number)("hello")     // true
is.union(is.string, is.number)(42)          // true

// Allows undefined
is.optional(is.string)(undefined)           // true
is.optional(is.string)("hi")               // true

// Allows null
is.nullable(is.string)(null)               // true

// Fixed-length tuple with per-index predicates
is.tuple(is.string, is.number)(["hi", 1]) // true

// Exact value match
is.literal("admin")("admin")              // true
```

## Integration Candidates

- `packages/eight/tools.ts` - validate tool call argument shapes at runtime
- `packages/permissions/policy-engine.ts` - validate YAML policy object structure
- `packages/memory/store.ts` - validate memory record shape before insert
- Any JSON ingestion point that currently uses `as` casts

## Why Quarantine

No existing usage yet. Needs a real consumer before promoting to index. Pattern is proven and the implementation is zero-dependency.

## Promotion Criteria

- [ ] At least one package imports and uses `is` from this module
- [ ] A test file covers the combinators
- [ ] Added to `packages/tools/index.ts` exports
