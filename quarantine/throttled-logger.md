# throttled-logger

**Tool name:** ThrottledLogger
**Status:** quarantine
**File:** `packages/tools/throttled-logger.ts`

## Description

A rate-limiting logger that deduplicates repeated log messages within a configurable time window. Identical messages are emitted up to `maxPerWindow` times per window; additional occurrences are suppressed and counted. At the end of each window a summary is flushed reporting how many times each message was suppressed and its total call count.

Supports four levels: `log`, `info`, `warn`, `error`. Configurable window size, per-window cap, flush interval, and output function.

## API

```ts
import { ThrottledLogger } from "./packages/tools/throttled-logger.ts";

const logger = new ThrottledLogger({ windowMs: 5000, maxPerWindow: 3 });
logger.info("Connected");   // emitted
logger.info("Connected");   // emitted (count 2)
logger.info("Connected");   // emitted (count 3)
logger.info("Connected");   // suppressed
logger.stats();             // [{ level: "info", message: "Connected", count: 4, suppressed: 1 }]
logger.destroy();           // flush summary + stop timer
```

## Integration path

1. Wire into `packages/eight/agent.ts` as the default logger to reduce noise from repeated tool-use messages during long sessions.
2. Optionally expose via `packages/tools/index.ts` for use by other packages.
3. Confirm no conflicts with existing `packages/tools/rate-limiter.ts` (different concern - that one gates execution, this one gates output).

## Why quarantine?

- Not yet wired into any consumer.
- Needs decision on whether `destroy()` should be called automatically at session end.
- Flush output format may need alignment with the TUI log display convention.
