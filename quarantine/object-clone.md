# quarantine: object-clone

**Status:** quarantine - review before wiring into agent loop

## What it does

Three cloning utilities for any value: shallow, deep, and custom. Handles
circular references, special types, and per-value overrides without pulling
in a third-party library.

## API

```ts
import {
  clone,
  deepClone,
  cloneWith,
} from "../packages/tools/object-clone.ts";

// Shallow - special types are deep-copied, nested objects share references
const a = clone({ date: new Date(), nested: { x: 1 } });

// Deep - full recursive copy, circular refs handled safely
const b = deepClone({ a: { b: { c: 42 } } });

// Custom - per-value override, falls back to deep-clone logic
const c = cloneWith(obj, (value, key) => {
  if (key === "password") return "[REDACTED]";
  // return undefined to use default cloning
});
```

## Features

- `clone(obj)` - shallow copy; Arrays use `.slice()`, objects use `Object.assign` with prototype preserved
- `deepClone(obj)` - recursive deep copy with a `Map`-backed seen set for circular ref safety
- `cloneWith(obj, customizer)` - same deep logic but calls `customizer(value, key, parent)` at every node; return a value to replace, `undefined` to continue
- Special types cloned correctly: `Date`, `RegExp`, `Map`, `Set`, `Buffer`
- Symbol keys are preserved on plain objects
- Prototype chain preserved for non-plain objects

## Constraints

- `Map` shallow-clone (`clone()`) copies the entry references, not deep entries - use `deepClone` if entries are mutable objects
- Functions are not cloned - returned as-is (same reference)
- `WeakMap` / `WeakSet` are not cloneable by design (no enumerable keys)

## Files

- `packages/tools/object-clone.ts` - implementation (~145 lines)

## Not doing

- No typed-array handling (Uint8Array etc) - add if needed
- No class instance method rebinding - only data properties
- No schema validation on clone output
