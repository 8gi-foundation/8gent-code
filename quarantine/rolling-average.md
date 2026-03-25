# rolling-average

## Tool Name
`rolling-average`

## Description
Simple and exponential moving average calculators for tracking agent performance metrics.
Provides online statistics (variance, stddev, min, max) without storing full history.

- `SimpleMovingAverage(windowSize)` - fixed-window SMA, O(windowSize) memory
- `ExponentialMovingAverage(alpha)` - infinite-horizon EMA, O(1) memory, Welford variance

## Status
**quarantine** - self-contained, no external deps, not yet wired into any benchmark or metrics pipeline.

## Integration Path
1. Import from `packages/tools/rolling-average.ts`
2. Wire into `benchmarks/autoresearch/harness.ts` to track per-loop latency and score deltas
3. Optionally expose via `packages/eight/tools.ts` as a metric-tracking tool for agents
4. Graduate from quarantine once used in at least one benchmark loop with measurable output
