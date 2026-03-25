# exec-timer

**Status:** Quarantine - awaiting review
**File:** `packages/tools/exec-timer.ts`
**Lines:** ~120

## What it does

Measures execution time of synchronous and asynchronous functions. Provides a benchmark mode that runs a function N times and returns aggregate stats (mean, median, min, max, p95).

## API

```ts
import { time, timeAsync, benchmark, benchmarkAsync } from './packages/tools/exec-timer';

// Sync
const { result, durationMs } = time(() => expensiveComputation());

// Async
const { result, durationMs } = await timeAsync(() => fetch('/api/data').then(r => r.json()));

// Benchmark - sync, 200 iterations
const stats = benchmark(() => JSON.parse(largeJson), 200);
// { mean, median, min, max, p95, iterations }

// Benchmark - async, 50 iterations
const stats = await benchmarkAsync(() => db.query('SELECT 1'), 50);
```

## Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `time` | `<T>(fn: () => T) => TimedResult<T>` | Single sync measurement |
| `timeAsync` | `<T>(fn: () => Promise<T>) => Promise<TimedResult<T>>` | Single async measurement |
| `benchmark` | `(fn, iterations?) => BenchmarkStats` | Multi-run sync stats |
| `benchmarkAsync` | `(fn, iterations?) => Promise<BenchmarkStats>` | Multi-run async stats |

## Types

```ts
interface TimedResult<T> {
  result: T;
  durationMs: number;
}

interface BenchmarkStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  p95: number;
  iterations: number;
}
```

## Why quarantine?

Small utility with no external dependencies. Needs review before wiring into `packages/tools/index.ts`. Potential use in harness timing, agent loop profiling, and kernel training metrics.

## Acceptance criteria

- [ ] Reviewed by James
- [ ] Add to `packages/tools/index.ts` exports
- [ ] Consider integration with `perf-mark.ts` for named spans
