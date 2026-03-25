# enum-helper

**Tool:** `packages/tools/enum-helper.ts`
**Status:** quarantine

## Description

Utilities for working with TypeScript string enums at runtime. TypeScript string
enums compile down to plain objects, but the standard library provides no helpers
for iterating values, performing type-safe guards, or parsing strings into enum
members. This module fills that gap in a zero-dependency, ~120-line file.

## API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `createEnum` | `(values: string[]) => Readonly<Record<V, V>>` | Build a const enum object from a value list |
| `enumValues` | `(enumObj) => V[]` | Return all enum values as an array |
| `enumKeys` | `(enumObj) => K[]` | Return all enum keys as an array |
| `isEnumValue` | `(enumObj, val) => val is V` | Type guard for enum membership |
| `enumFromString` | `(enumObj, str, fallback, opts?) => V` | Parse a string with fallback, optional case-insensitive |

## Integration Path

1. **Immediate** - import directly anywhere enum iteration or parsing is needed:
   ```ts
   import { createEnum, isEnumValue } from '../../packages/tools/enum-helper';
   ```
2. **Re-export** - add to `packages/tools/index.ts` once usage is confirmed in at
   least one production callsite.
3. **Agent tooling** - `packages/eight/tools.ts` can use `isEnumValue` to validate
   tool parameter enums without writing bespoke guards per tool.

## Notes

- No external dependencies.
- All functions are pure and synchronous.
- `createEnum` returns a frozen object - mutations throw in strict mode.
- `enumFromString` supports case-insensitive matching via `{ caseInsensitive: true }`.
