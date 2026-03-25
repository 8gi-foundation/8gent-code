# sparse-array

**Tool name:** SparseArray
**File:** `packages/tools/sparse-array.ts`
**Status:** quarantine

## Description

Memory-efficient sparse array for large index ranges. Uses a Map as backing
store so only populated slots consume memory - ideal for index spaces where
most positions are empty (e.g. AST node offsets, token position maps, large
buffer indices).

## API

| Method / Property | Description |
|-------------------|-------------|
| `get(index)` | Read value at index; returns defaultValue if unset |
| `set(index, value)` | Write value at index |
| `delete(index)` | Remove entry, revert to defaultValue |
| `has(index)` | True if index is explicitly populated |
| `count` | Number of populated slots |
| `entries()` | Iterate non-empty entries in ascending order |
| `values()` | Iterate values in ascending order |
| `range(start, end)` | All entries within [start, end] inclusive |
| `maxIndex / minIndex` | Bounds of populated range |
| `toDense()` | Compact to standard array (gaps filled with defaultValue) |
| `clear()` | Remove all entries |
| `clone()` | Shallow copy |

## Integration path

1. Import into any package: `import { SparseArray } from '../tools/sparse-array'`
2. Wire into `packages/tools/index.ts` export when promoted from quarantine
3. Candidate users: `packages/ast-index/` (token offset maps), `packages/memory/` (large history buffers)

## Promotion criteria

- Unit tests pass covering get/set/range/toDense/clone
- Used by at least one package with a measurable outcome (benchmark or test count)
- Reviewed and merged into `packages/tools/index.ts`
