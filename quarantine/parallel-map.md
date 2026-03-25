# quarantine: parallel-map

**Status:** quarantine - review before wiring into agent loop

## What it does

Four async array operations - map, filter, forEach, reduce - each running up
to `concurrency` callbacks at a time. Order is always preserved. All functions
respect AbortSignal and throw an AbortError mid-flight if the signal fires.

## API

```ts
import {
  parallelMap,
  parallelFilter,
  parallelForEach,
  parallelReduce,
} from "../packages/tools/parallel-map.ts";

// Map - transform items in parallel, order preserved
const sizes = await parallelMap(filePaths, async (p, _i, signal) => {
  return fetchSize(p, signal);
}, 8, abortSignal);

// Filter - keep items where predicate returns true
const existing = await parallelFilter(paths, async (p) => {
  return fileExists(p);
}, 4);

// ForEach - side effects in parallel
await parallelForEach(jobs, async (job, i, signal) => {
  await runJob(job, signal);
}, 4, abortSignal);

// Reduce - associative reduction over batched parallel passes
const total = await parallelReduce(numbers, async (acc, n) => acc + n, 0, 4);
```

## Features

- Configurable `concurrency` parameter (default: 4) on all four functions
- Pool-based scheduling - workers share a single index, no item is processed twice
- Abort support - `AbortSignal` passed through to each callback; throws AbortError on cancellation
- Order preserved on map and filter regardless of completion order
- Sequential fallback in `parallelReduce` when `concurrency === 1`

## Constraints

- `parallelReduce` requires an associative `fn` for correct results in parallel mode
- No retry logic - compose externally if needed
- A single item error rejects the entire operation (fail-fast)
- `concurrency` clamped to `items.length` internally - no excess workers spawned

## Files

- `packages/tools/parallel-map.ts` - implementation (~150 lines)

## Not doing

- No partial-results collection on error (use `parallelMap` + `Promise.allSettled` externally)
- No streaming of results as they complete - full array returned after all items settle
- No automatic retry on item failure
