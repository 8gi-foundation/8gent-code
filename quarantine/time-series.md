# Quarantine: time-series

**Status:** Quarantined - pending integration decision

## What it does

`packages/tools/time-series.ts` - lightweight in-memory time-series store for agent metrics and telemetry.

## API

```ts
import { TimeSeries } from "./packages/tools/time-series.ts";

const ts = new TimeSeries();
ts.add(42);                          // value, timestamp defaults to Date.now()
ts.add(55, Date.now() - 5000);       // explicit timestamp

ts.range(from, to);                  // DataPoint[] in time range
ts.latest(10);                       // 10 most recent points, newest first

ts.avg(60_000);                      // average over last 60s
ts.min(60_000);                      // min over last 60s
ts.max(60_000);                      // max over last 60s
ts.sum(60_000);                      // sum over last 60s

ts.downsample(5_000, "avg");         // bucket into 5s intervals, reduce by avg
ts.downsample(5_000, "count");       // event counts per bucket
```

## Use cases

- Token usage per session (track and graph over time)
- Benchmark scores across autoresearch loop iterations
- Tool call latency monitoring
- Memory DB growth tracking
- Any agent telemetry that needs windowed aggregation

## Integration path

- Wire into `packages/memory/health.ts` for memory growth metrics
- Add to benchmark harness to track score drift over loop iterations
- Expose in debugger v2 for real-time latency graphs

## Size

~130 lines. No deps. Pure TypeScript.
