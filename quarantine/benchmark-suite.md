# benchmark-suite

**Status:** Quarantine - under review before wiring into the main agent loop

## What it does

`BenchmarkSuite` organizes benchmarks into named suites. Each suite supports sync and async benchmarks, configurable warmup and iteration counts, automatic fastest/slowest markers, and a formatted results table.

## Location

`packages/tools/benchmark-suite.ts`

## API

```ts
import { BenchmarkSuite } from "./packages/tools/benchmark-suite";

const suite = new BenchmarkSuite("JSON vs msgpack");

suite
  .add("JSON.stringify", () => JSON.stringify({ a: 1, b: [2, 3] }))
  .add("JSON.parse", () => JSON.parse('{"a":1,"b":[2,3]}'))
  .addAsync("fetch mock", async () => {
    await Promise.resolve("ok");
  });

const results = await suite.run({ warmup: 10, iterations: 200 });
console.log(suite.formatResults(results));
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `warmup` | 5 | Iterations discarded before timing starts |
| `iterations` | 100 | Timed iterations per benchmark |
| `silent` | false | Suppress automatic console output |

## Output format

```
--- JSON vs msgpack ---
warmup: 10 | iterations: 200

name              avg (ms)   min (ms)   max (ms)      ops/sec    marker
---------------------------------------------------------------------------
JSON.stringify      0.0012     0.0008     0.0041        833333   fastest
JSON.parse          0.0018     0.0011     0.0052        555556
fetch mock          0.0210     0.0190     0.0440         47619   slowest
```

## Integration path

- Wire into `benchmarks/autoresearch/harness.ts` for per-task timing
- Use in `bun run benchmark:v2` to compare model latency side-by-side
- Candidate for `packages/tools/index.ts` export once reviewed
