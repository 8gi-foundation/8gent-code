# json-patch

**Tool name:** json-patch
**Status:** quarantine
**Package:** `packages/tools/json-patch.ts`

## Description

Self-contained RFC 6902 JSON Patch implementation. No runtime dependencies.

Supports all six operations: `add`, `remove`, `replace`, `move`, `copy`, `test`.

Also includes patch generation (diff two objects into a minimal patch) and structural validation of patch arrays.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `applyPatch` | `(doc: T, ops: PatchOp[]) => T` | Apply ops to a document (deep-cloned, non-mutating) |
| `generatePatch` | `(before, after) => PatchOp[]` | Diff two objects into a minimal patch |
| `validatePatch` | `(ops: unknown[]) => string[]` | Structural validation - returns error messages |

## Integration path

1. Import into `packages/tools/index.ts` when promoted from quarantine.
2. Wire as an Eight tool in `packages/eight/tools.ts` for agent-driven JSON transforms.
3. Useful for: memory store migrations, config patching, agent state diffs, API response transforms.

## Usage example

```ts
import { applyPatch, generatePatch, validatePatch } from "./json-patch.ts";

const doc = { a: 1, b: { c: 2 } };
const patched = applyPatch(doc, [{ op: "replace", path: "/b/c", value: 99 }]);
// { a: 1, b: { c: 99 } }

const ops = generatePatch({ x: 1 }, { x: 1, y: 2 });
// [{ op: "add", path: "/y", value: 2 }]

const errors = validatePatch([{ op: "add", path: "/x" }]);
// ["op[0]: add requires a 'value'"]
```

## Promotion checklist

- [ ] Unit tests passing
- [ ] Edge cases verified: root path, array `-` append, pointer escaping (`~0`, `~1`)
- [ ] Wired into `packages/tools/index.ts`
- [ ] Eight tool definition added if agent use case confirmed
