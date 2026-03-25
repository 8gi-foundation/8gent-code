# type-narrowing

**Tool:** `packages/tools/type-narrowing.ts`
**Status:** quarantine

## Description

Runtime type narrowing utilities for unknown values. Provides a full set of TypeScript type guards that narrow `unknown` to specific types at runtime, plus helpers for assertion, conditional narrowing, key extraction, and union guards.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `isString` | `(v: unknown) => v is string` | String guard |
| `isNumber` | `(v: unknown) => v is number` | Number guard (NaN-safe) |
| `isBoolean` | `(v: unknown) => v is boolean` | Boolean guard |
| `isArray` | `(v: unknown) => v is unknown[]` | Array guard |
| `isTypedArray` | `(v, guard) => v is T[]` | Typed array with item guard |
| `isObject` | `(v: unknown) => v is Record<string, unknown>` | Plain object guard (excludes Date, Error, Promise) |
| `isFunction` | `(v: unknown) => v is Function` | Function guard |
| `isDate` | `(v: unknown) => v is Date` | Date guard (invalid Date-safe) |
| `isError` | `(v: unknown) => v is Error` | Error guard |
| `isPromise` | `(v: unknown) => v is Promise<unknown>` | Promise/thenable guard |
| `isNullish` | `(v: unknown) => v is null \| undefined` | Null or undefined guard |
| `isNonNullable` | `(v: T) => v is NonNullable<T>` | Non-null/non-undefined guard |
| `assertType` | `(v, guard, label?) => asserts v is T` | Throws TypeError if guard fails |
| `narrow` | `(v, guard) => T \| undefined` | Silent narrowing - returns undefined on miss |
| `pickKey` | `(v, key, guard) => T \| undefined` | Extract a typed key from unknown object |
| `oneOf` | `(...guards) => union guard` | Compose multiple guards into a union |

## Integration Path

1. Import from `packages/tools/type-narrowing.ts` wherever `unknown` values enter the system (API responses, tool outputs, memory reads, config parsing).
2. Wire into `packages/tools/index.ts` exports once the quarantine review is complete.
3. Consider pairing with `safe-json-parse.ts` - the JSON parser can return `unknown`, and these guards handle the downstream narrowing.
4. The `assertType` function is suitable for trust boundary enforcement in agent tool handlers.

## Why Quarantine

No breaking changes. Self-contained with zero dependencies. Quarantined to allow review of the API surface before locking into the public tools index.
