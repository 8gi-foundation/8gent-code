# Quarantine: Bundle Size Tracker

## Status: Quarantined

## What it does

`packages/validation/bundle-tracker.ts` tracks dist/ bundle sizes across builds. It:

1. Scans a dist/ directory and records file sizes as a snapshot
2. Stores snapshot history in `.8gent/bundle-history.json`
3. Compares consecutive snapshots and alerts when any file grows >10%
4. Generates a human-readable size history report

## API

| Export | Purpose |
|--------|---------|
| `track(distDir?)` | Scan dist/, save snapshot, return alerts if any file grew >10% |
| `report()` | Return formatted size history string |
| `scanDist(dir)` | List all files with byte sizes |
| `loadHistory()` | Read stored snapshots |
| `detectAlerts(prev, curr)` | Compare two snapshots, return files exceeding threshold |

## Usage

```ts
import { track, report } from "./packages/validation/bundle-tracker";

const { snapshot, alerts } = track("dist");
if (alerts.length > 0) {
  console.warn("Bundle size regressions:", alerts);
}
console.log(report());
```

## Why quarantined

- No integration with CI or build pipeline yet
- No tests written
- Needs validation against real build output before wiring into the harness

## Exit criteria

- [ ] Unit tests covering alert detection and history persistence
- [ ] Wired into at least one build script or CI step
- [ ] Confirmed useful on a real dist/ output
