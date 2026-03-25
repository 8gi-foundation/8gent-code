# rate-monitor

## Tool Name
`rate-monitor`

## Description
Sliding-window event rate tracker with threshold-based alerting for anomaly detection.
Multiple named counters, each with an independent timestamp buffer and optional alert band.

- `RateMonitor` - class managing N named counters
- `record(name, count?, windowMs?)` - push events into a counter
- `rate(name, windowMs?)` - current events-per-second over the window
- `setThreshold(name, min, max, callback)` - fire callback when rate leaves [min, max]
- `clearThreshold(name)` - remove threshold without clearing events
- `reset(name?)` - clear one counter or all counters
- `stats(name)` - full snapshot: count, rate, windowMs, oldest/newest timestamps
- `names()` - list all tracked counter names

## Status
**quarantine** - self-contained, no external deps, not yet wired into any monitoring or benchmark pipeline.

## Integration Path
1. Import from `packages/tools/rate-monitor.ts`
2. Wire into `benchmarks/autoresearch/harness.ts` to detect runaway or stalled benchmark loops
3. Use inside `packages/eight/agent.ts` to monitor tool-call rate per session and alert on anomalies
4. Graduate from quarantine once used in at least one live session with a measurable alert firing
