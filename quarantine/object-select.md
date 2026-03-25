# quarantine: object-select

**Status:** quarantine - review before wiring into agent loop

## What it does

Six pure object field-selection and transformation utilities with no external
dependencies. Covers the most common "reshape this object" patterns agents
encounter when normalising tool output, cleaning API responses, or building
structured payloads.

## API

```ts
import {
  select,
  selectDeep,
  exclude,
  rename,
  mapKeys,
  mapValues,
} from "../packages/tools/object-select.ts";

// Pick top-level keys
select({ a: 1, b: 2, c: 3 }, ['a', 'c']);
// { a: 1, c: 3 }

// Pick values at deep dot-paths - returns flat record keyed by path string
selectDeep({ user: { name: 'Alice', age: 30 }, id: 1 }, ['user.name', 'id']);
// { 'user.name': 'Alice', id: 1 }

// Remove keys
exclude({ a: 1, b: 2, c: 3 }, ['b']);
// { a: 1, c: 3 }

// Rename keys - unmapped keys pass through unchanged
rename({ firstName: 'Alice', age: 30 }, { firstName: 'name' });
// { name: 'Alice', age: 30 }

// Transform every key with a function (last-wins on collision)
mapKeys({ fooBar: 1, bazQux: 2 }, k => k.toLowerCase());
// { foobar: 1, bazqux: 2 }

// Transform every value, receives (value, key)
mapValues({ a: 1, b: 2, c: 3 }, v => v * 2);
// { a: 2, b: 4, c: 6 }
```

## Features

- `select` - picks top-level fields, TypeScript `Pick<T, K>` return type
- `selectDeep` - resolves dot-separated paths through nested objects
- `exclude` - shallow copy with specified keys removed, `Omit<T, K>` return type
- `rename` - renames keys per a mapping, passes unmapped keys through unchanged
- `mapKeys` - rebuilds object with every key transformed by a function
- `mapValues` - rebuilds object with every value transformed by a function
- All functions are pure - no mutation of the source object
- No external dependencies

## Constraints

- `selectDeep` returns a flat record keyed by the full path string, not a nested object
- `selectDeep` yields `undefined` for missing or unreachable paths - check before use
- `mapKeys` last-wins on key collision - document your assumption if keys could collide
- All functions operate on plain objects - class instances with prototype methods are not preserved

## Files

- `packages/tools/object-select.ts` - implementation (~140 lines)

## Not doing

- No deep merge or recursive transform - compose `mapValues` with recursion yourself
- No array-of-objects bulk select - use `Array.map` with `select` or `selectDeep`
- No schema validation - pair with `config-validator.ts` if you need that
- No setter/mutation variants - all returns are new objects
