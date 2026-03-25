# pattern-matcher

## Tool Name
`pattern-matcher`

## Description
Rust-style pattern matching for TypeScript values. Provides a fluent `match(value).with(pattern, handler).otherwise(default)` API that supports four pattern kinds:

- **Literal** - exact equality against a `string | number | boolean | null | undefined` constant
- **Type guard** - a TypeScript type predicate `(v): v is T => ...` that narrows the matched value for the handler
- **Predicate** - any `(value) => boolean` function, evaluated left-to-right; first truthy wins
- **Wildcard** - the exported `__` sentinel, always matches; used as a catch-all before `.otherwise()`

Patterns are evaluated in declaration order. The chain is lazy: once a pattern matches, subsequent `.with()` calls are skipped. `.exhaustive()` throws if nothing matched; `.otherwise()` provides a safe default.

## Status
`quarantine`

The implementation is self-contained (< 150 lines, zero dependencies) and passes manual smoke tests. It has not yet been integrated into the agent tool registry or wired into any existing workflow.

## Integration Path
1. Export `match` and `__` from `packages/tools/index.ts` alongside other utilities.
2. Optionally register as an Eight tool in `packages/eight/tools.ts` if agent code would benefit from declarative branching (e.g. routing tool responses by type).
3. Add unit tests in `packages/tools/__tests__/pattern-matcher.test.ts` covering all four pattern kinds and the `exhaustive()` throw path before promoting to stable.
