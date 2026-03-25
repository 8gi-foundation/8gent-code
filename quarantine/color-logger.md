# color-logger

**Tool name:** ColorLogger
**Status:** quarantine
**File:** `packages/tools/color-logger.ts`

## Description

A terminal logger with automatic level-based ANSI coloring, namespace support, hierarchical child loggers, level filtering, and TTY auto-detection. When stderr is not a TTY (CI, log files, piped output) all ANSI codes are stripped and plain-text output is emitted instead.

Five levels: `debug` (dim), `info` (cyan), `warn` (yellow), `error` (red), `success` (green). Each line is prefixed with an ISO timestamp and an optional namespace label.

## API

```ts
import { createLogger } from "./packages/tools/color-logger.ts";

// Root logger
const log = createLogger();
log.debug("starting up");
log.info("server listening on :3000");
log.warn("rate limit approaching");
log.error("connection refused");
log.success("build complete");

// Namespaced logger
const agentLog = createLogger("agent");
agentLog.info("task dispatched");   // [agent] [INF] task dispatched

// Child logger - inherits settings, appends namespace segment
const toolLog = agentLog.child("tools");
toolLog.debug("calling bash");      // [agent:tools] [DBG] calling bash

// Filtered logger - only warn and above
const quietLog = createLogger("kernel", { minLevel: "warn" });
quietLog.debug("ignored");
quietLog.warn("checkpoint stale");  // emitted

// Force plain output in tests
const testLog = createLogger("test", { tty: false, timestamps: false });
```

## Integration path

1. Replace ad-hoc `console.log` calls in `packages/eight/agent.ts` and `packages/daemon/` with namespaced loggers from `createLogger`.
2. Export from `packages/tools/index.ts` once adoption is confirmed.
3. In CI / Fly.io deployment, TTY is auto-detected as false - no config change needed for plain log output.

## Why quarantine?

- Not yet wired into any consumer.
- Output format (stderr vs stdout) needs alignment with the TUI log display convention.
- `minLevel` default may need to be `"info"` in production builds - decision pending.
- No file-sink or structured JSON mode yet; evaluate whether that's needed before promoting.
