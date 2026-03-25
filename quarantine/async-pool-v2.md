# Quarantine: async-pool-v2

**File:** `packages/tools/async-pool-v2.ts`
**Status:** Quarantine review
**Size:** ~130 lines

## What It Does

`asyncPool(items, fn, options)` runs an async function over an array with bounded concurrency. Returns ordered results matching the input array.

## API

```ts
asyncPool<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: AsyncPoolOptions<T>
): Promise<R[] | PoolResult<R>[]>
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `5` | Max parallel tasks |
| `errorMode` | `"fail-fast" \| "collect" \| "ignore"` | `"fail-fast"` | How to handle rejections |
| `onProgress` | `(completed, total, index) => void` | - | Progress callback per item |
| `onError` | `(error, index) => void` | - | Error callback (all modes) |
| `signal` | `AbortSignal` | - | Cancel remaining tasks |

### Error Modes

- **fail-fast** - first rejection throws, remaining tasks are skipped (default)
- **collect** - all items run; returns `PoolResult<R>[]` (each has `ok: true/false`)
- **ignore** - errors silently dropped; failed slots are `undefined`

## Usage

```ts
import { asyncPool } from "./packages/tools/async-pool-v2.ts";

// Basic - fail-fast
const results = await asyncPool(urls, fetch, { concurrency: 3 });

// Collect all results including errors
const results = await asyncPool(items, process, {
  concurrency: 4,
  errorMode: "collect",
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

// With abort
const controller = new AbortController();
const results = await asyncPool(items, fn, {
  signal: controller.signal,
});
```

## Promotion Criteria

- [ ] Unit tests covering all three error modes
- [ ] AbortSignal cancel path tested
- [ ] onProgress callback verified for ordered completion reporting
- [ ] Benchmark: 1000 items at concurrency 10 - confirm no memory leak
- [ ] Integration: wire into `packages/orchestration/` worktree pool as an option
