# quarantine: object-entries-typed

**Status:** quarantined - not yet wired into production
**File:** `packages/tools/object-entries-typed.ts`
**Size:** ~120 lines

## Problem

TypeScript's built-in `Object.entries`, `Object.keys`, and `Object.values`
return `string[]` or `[string, T][]`, discarding the literal key union. Every
call site ends up with a cast or a `// @ts-ignore`.

## What it adds

| Export | Signature | Purpose |
|--------|-----------|---------|
| `typedKeys` | `<T>(obj: T) => (keyof T)[]` | Keys with literal union preserved |
| `typedValues` | `<T>(obj: T) => T[keyof T][]` | Values with type preserved |
| `typedEntries` | `<T>(obj: T) => [keyof T, T[keyof T]][]` | Entries with full types |
| `typedFromEntries` | `<K, V>(entries) => Record<K, V>` | Typed Object.fromEntries |
| `mapObject` | `<T, U>(obj, fn) => Record<keyof T, U>` | Map values, keep keys |
| `filterObject` | `<T>(obj, pred) => Partial<T>` | Filter entries by predicate |
| `pickKeys` | `<T, K>(obj, keys) => Pick<T, K>` | Runtime Pick utility |
| `omitKeys` | `<T, K>(obj, keys) => Omit<T, K>` | Runtime Omit utility |

## Usage

```ts
import {
  typedEntries,
  typedKeys,
  typedValues,
  typedFromEntries,
  mapObject,
  filterObject,
  pickKeys,
  omitKeys,
} from '../packages/tools/object-entries-typed';

const config = { host: 'localhost', port: 3000, debug: true };

// Keys narrowed to "host" | "port" | "debug"
typedKeys(config).forEach((k) => console.log(k, config[k]));

// Double all numeric values
const doubled = mapObject({ a: 1, b: 2 }, (v) => v * 2);
// { a: 2, b: 4 }

// Keep only truthy values
const active = filterObject({ x: 0, y: 1, z: 2 }, (v) => Boolean(v));
// { y: 1, z: 2 }

// Subset of keys
const subset = pickKeys(config, ['host', 'port']);
// { host: 'localhost', port: 3000 }

// Exclude keys
const public_ = omitKeys(config, ['debug']);
// { host: 'localhost', port: 3000 }
```

## Promotion criteria

- [ ] At least two call sites in the codebase benefit from the typed wrappers
- [ ] No `@ts-ignore` or manual casts needed at those call sites
- [ ] Exported from `packages/tools/index.ts`

## Why quarantined

Low blast radius - it's additive only. Quarantined until there's a concrete
call site that benefits, so we don't add surface area speculatively.
