# rate-window

## Tool Name
`rate-window`

## Description
Sliding window rate counter for monitoring request rates. Tracks event timestamps within a configurable time window and exposes per-second/per-minute rates, approximate inter-arrival gap percentiles (p50/p95/p99), and configurable alert thresholds with callback support.

## Status
`quarantine` - self-contained, no external dependencies, not yet wired into any agent or provider pipeline.

## File
`packages/tools/rate-window.ts`

## Exports
- `RateWindow` - main class
- `RateWindowOptions` - constructor config interface
- `RateWindowSnapshot` - snapshot return type

## API Summary

```ts
const rw = new RateWindow({
  windowMs: 60_000,       // 1-minute sliding window
  maxEvents: 10_000,      // memory cap
  alertThreshold: 500,    // fire onAlert when count >= 500
  onAlert: (rate, snap) => console.warn('High rate', rate),
});

rw.record();              // record event now
rw.record(timestampMs);   // record event at custom time

const snap = rw.snapshot();
// snap.count, snap.ratePerSecond, snap.ratePerMinute
// snap.p50GapMs, snap.p95GapMs, snap.p99GapMs
```

## Integration Path
1. Import into `packages/eight/tools.ts` as a monitoring utility.
2. Wire into the provider or HTTP client layer to track outbound request rates.
3. Expose a `/rate` debug endpoint in the daemon (`packages/daemon/`) using `snapshot()`.
4. Optionally connect alert callback to the Telegram bot (`packages/telegram/`) for real-time spike notifications.

## Size
~150 lines TypeScript. Zero external dependencies.
