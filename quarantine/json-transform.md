# json-transform

## Description

Transforms JSON structures using declarative mapping rules. Supports path remapping with optional transform functions, key renaming, template-based reshaping, and field picking/omitting. Zero dependencies, pure TypeScript.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `transform` | `(data, rules: TransformRule[]) => JsonObject` | Map source dot-paths to dest dot-paths with optional transform fn per rule |
| `rename` | `(data, mapping: Record<string, string>) => JsonObject` | Rename top-level keys; unmapped keys pass through unchanged |
| `reshape` | `(data, template: JsonObject) => JsonObject` | Build a new shape from a template; `$path` values resolve from source |
| `pick` | `(data, paths: string[]) => JsonObject` | Return only the specified dot-notation paths |
| `omit` | `(data, keys: string[]) => JsonObject` | Shallow copy minus the specified top-level keys |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/memory/` consolidation to reshape raw episodic records into semantic memory format.
3. Use in `packages/validation/` to normalize agent output shapes before scoring.
4. Expose as an agent tool so Eight can remap API response payloads to internal schema without custom glue code.

## Source

`packages/tools/json-transform.ts` - 130 lines, zero dependencies, pure TypeScript.
