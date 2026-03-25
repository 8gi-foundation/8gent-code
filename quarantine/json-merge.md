# json-merge

## Description

RFC 7396 JSON Merge Patch implementation for partial JSON document updates. Supports applying a patch to a target document and generating a patch that describes the diff between two documents.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `mergePatch` | `(target: JsonValue, patch: JsonValue) => JsonValue` | Apply RFC 7396 merge patch (deep clone, non-mutating) |
| `applyMergePatch` | `(target: JsonValue, patch: JsonValue) => JsonValue` | Immutable alias for mergePatch |
| `generateMergePatch` | `(original: JsonValue, modified: JsonValue) => JsonValue` | Generate patch from two documents |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/validation/` checkpoint merge logic to produce minimal diffs before reverting.
3. Expose as an agent tool so Eight can apply partial config updates without replacing full documents.
4. Use in memory consolidation (`packages/memory/`) to patch semantic memories with incremental updates.

## Source

`packages/tools/json-merge.ts` - 130 lines, zero dependencies, pure TypeScript.
