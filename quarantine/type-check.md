# Quarantine: type-check

## What

Comprehensive runtime type checking with detailed type strings and assertion helpers. Goes beyond `typeof` to correctly identify `null`, arrays, dates, regex, promises, errors, maps, sets, and more via `Object.prototype.toString`.

## File

`packages/tools/type-check.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { typeOf, is, assertType, checkType } from './packages/tools/type-check.ts';

// typeOf - detailed type string
typeOf(null)           // "null"
typeOf(undefined)      // "undefined"
typeOf([])             // "array"
typeOf(new Date())     // "date"
typeOf(/foo/)          // "regex"
typeOf(new Map())      // "map"
typeOf(new Set())      // "set"
typeOf(Promise.resolve()) // "promise"
typeOf(new Error())    // "error"
typeOf(NaN)            // "NaN"
typeOf(42)             // "number"
typeOf("hello")        // "string"

// is - type guard helpers (TypeScript-narrowing)
is.string("hi")        // true
is.number(42)          // true
is.boolean(false)      // true
is.array([1, 2])       // true
is.object({})          // true
is.function(() => {})  // true
is.null(null)          // true
is.undefined(undefined) // true
is.nullish(null)        // true
is.date(new Date())    // true
is.regex(/x/)          // true
is.promise(Promise.resolve()) // true
is.error(new Error())  // true
is.map(new Map())      // true
is.set(new Set())      // true
is.integer(5)          // true
is.finite(Infinity)    // false
is.nan(NaN)            // true

// assertType - throws TypeError with detailed message on mismatch
assertType(42, "number")           // passes silently
assertType("hi", "number", "age") // throws: Type assertion failed for "age": expected number, got string ("hi")

// checkType - soft boolean version
checkType([], "array")   // true
checkType([], "object")  // false
```

## Reason for Quarantine

- No integration tests yet
- Not exported from `packages/tools/index.ts`
- Awaiting review before wiring into agent tool registry
