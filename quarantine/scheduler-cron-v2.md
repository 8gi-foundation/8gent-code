# Quarantine: scheduler-cron-v2

**Status:** Quarantine - not wired into production
**File:** `packages/tools/scheduler-cron-v2.ts`

## What it does

Improved cron scheduler over a bare `setInterval` approach:

- **Timezone support** - IANA timezone strings via `toLocaleString` to resolve fire dates in local time
- **Overlap protection** - `noOverlap: true` skips a tick if the previous run is still executing
- **maxRuns cap** - job self-terminates after N successful runs
- **Per-job error handler** - `onError` callback isolates failures; one bad job does not crash the manager
- **CronManager** - lightweight registry for multi-job lifecycle (add, remove, stopAll, status)

## API

```ts
import { CronJob, CronManager } from "../packages/tools/scheduler-cron-v2";

const job = new CronJob("report", "0 9 * * 1-5", async () => {
  await sendDailyReport();
}, {
  timezone: "Europe/Dublin",
  noOverlap: true,
  maxRuns: 5,
  onError: (err) => logError(err),
}).start();

const manager = new CronManager();
manager.add("heartbeat", "*/5 * * * *", ping, { noOverlap: true });
manager.add("cleanup", "0 2 * * *", runCleanup, { timezone: "UTC" });

console.log(manager.status());
// [{ id: "heartbeat", totalRuns: 3, isRunning: false }, ...]

manager.stopAll();
```

## Cron expression format

Standard 5-field: `min hour dom month dow`

Supported per field: `*`, `*/n`, `n`, `n-m`, `n,m`

## Constraints

- Minute-granularity next-fire resolution (1-min step, max 366-day lookahead)
- Uses `toLocaleString` for timezone math - available in Bun, Node, and browser
- No external dependencies

## Promotion checklist

- [ ] Unit tests: noOverlap, maxRuns, onError, timezone per-option branches
- [ ] Integration: add to `packages/eight/tools.ts` tool definitions
- [ ] Replace bare `setInterval` cron patterns in the codebase where they exist
