# json-diff

## Description

Deep structural comparison of two JSON-compatible values. Returns a flat array of diff operations describing how to transform the first value into the second.

Each operation has:
- `op` - `add` | `remove` | `replace`
- `path` - dot-notation path to the changed node (e.g. `user.address.city`, `items.2`)
- `oldValue` - previous value (present on `remove` and `replace`)
- `newValue` - incoming value (present on `add` and `replace`)

Handles nested objects, arrays (index-aligned), primitives, null, and mixed-type replacements.

## Status

**quarantine** - self-contained, no external dependencies, not yet wired into the agent tool registry.

## Integration Path

1. Add to `packages/eight/tools.ts` alongside existing tools.
2. Register as a built-in tool: name `json_diff`, description from above, params `a` and `b` (JSON).
3. Wire into the tool executor in `packages/eight/agent.ts`.
4. Add a benchmark test in `benchmarks/categories/abilities/` to verify diff correctness on known fixtures.

## Usage

```ts
import { jsonDiff } from "../packages/tools/json-diff.ts";

const ops = jsonDiff(
  { name: "Alice", age: 30, tags: ["a", "b"] },
  { name: "Alice", age: 31, tags: ["a", "b", "c"] }
);
// [
//   { op: "replace", path: "age",    oldValue: 30,  newValue: 31 },
//   { op: "add",     path: "tags.2", newValue: "c" }
// ]
```
