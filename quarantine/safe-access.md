# safe-access

## Description

Safely access, set, and inspect deeply nested object properties without throwing on null/undefined intermediate values. Includes pick and omit helpers for common object-shaping tasks.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `safeGet` | `(obj, path, default?) => T \| undefined` | Retrieve a value at a dot-notation path, returning default on missing keys |
| `safeSet` | `(obj, path, value) => T` | Set a value at a dot-notation path, creating intermediate objects as needed |
| `safeHas` | `(obj, path) => boolean` | Return true if the path resolves to a non-undefined value |
| `safePick` | `(obj, paths) => Record<string, unknown>` | Return a new object with only the specified paths resolved from the source |
| `safeOmit` | `(obj, keys) => Partial<T>` | Return a shallow clone of the object with specified top-level keys removed |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/eight/agent.ts` checkpoint restore logic to safely read nested session state.
3. Use in `packages/memory/store.ts` when merging episodic memory records with partial updates.
4. Use in `packages/permissions/policy-engine.ts` to safely navigate YAML policy trees without defensive null checks.

## Source

`packages/tools/safe-access.ts` - 130 lines, zero dependencies, pure TypeScript.
