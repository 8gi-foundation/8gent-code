# benchmark-harness

**Status:** quarantine

## Description

Micro-benchmark harness for measuring function performance. Supports warmup
passes, configurable iteration count, percentile statistics (p50/p95/p99), and
side-by-side comparison of multiple implementations.

## API

```ts
import { bench, compare } from "../packages/tools/benchmark-harness.ts";

// Single function
const result = await bench("myFn", () => myFn(input), { iterations: 2000 });

// Side-by-side comparison
await compare({
  "naive sort": () => naiveSort(arr),
  "built-in sort": () => arr.sort(),
});
```

## Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `bench` | `(name, fn, opts?) => Promise<BenchResult>` | Run one benchmark |
| `compare` | `(impls, opts?) => Promise<CompareResult>` | Compare multiple impls |

### BenchOptions

| Field | Default | Description |
|-------|---------|-------------|
| `iterations` | `1000` | Number of measured runs |
| `warmup` | `50` | Un-recorded warm-up runs |
| `unit` | `"ms"` | Output unit: `"ms"`, `"us"`, or `"ns"` |

### BenchResult fields

`name`, `iterations`, `unit`, `min`, `max`, `mean`, `p50`, `p95`, `p99`, `totalMs`

## Integration Path

1. Wire into `packages/tools/index.ts` exports once accepted.
2. Use in `benchmarks/autoresearch/` harness to profile tool call latencies.
3. Optionally surface p99 stats in the TUI debugger panel.

## File

`packages/tools/benchmark-harness.ts` - 148 lines, zero external dependencies.
