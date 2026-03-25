# Quarantine: range-generator

**File:** `packages/tools/range-generator.ts`
**Status:** Quarantine - pending integration review

## What it does

Python-style `range()` generator with supporting utilities for number sequences.

## Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `range` | `range(stop)` | Generator from 0 to stop-1 |
| `range` | `range(start, stop)` | Generator from start to stop-1 |
| `range` | `range(start, stop, step)` | Generator with step (positive or negative) |
| `rangeArray` | same overloads | Eager array version of range |
| `linspace` | `linspace(start, stop, count)` | count evenly spaced values, inclusive |
| `chunk` | `chunk(arr, size)` | Split array into size-length chunks |

## Usage examples

```ts
import { range, rangeArray, linspace, chunk } from "../packages/tools/range-generator";

// Lazy iteration - no array allocation
for (const i of range(5)) console.log(i); // 0 1 2 3 4

// Countdown
[...range(10, 0, -2)]; // [10, 8, 6, 4, 2]

// Eager array
rangeArray(1, 6); // [1, 2, 3, 4, 5]

// Evenly spaced (mirrors NumPy linspace)
linspace(0, 1, 5); // [0, 0.25, 0.5, 0.75, 1]

// Chunk
chunk([1, 2, 3, 4, 5], 2); // [[1,2],[3,4],[5]]
```

## Design notes

- `range()` is a generator - zero allocation for large sequences
- Matches Python semantics: stop is exclusive, step defaults to 1
- `linspace` pins the last element to exactly `stop` to avoid float drift
- `chunk` is generic (`T[]`) - works on any array type
- No dependencies

## Integration candidates

- Agent loop iteration utilities
- Benchmark harness - generate test case indices
- Orchestration - slice work into chunks for parallel workers
- Any tool that currently hand-rolls `for (let i = 0; i < n; i++)` loops
