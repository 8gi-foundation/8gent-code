# Quarantine: structured-logger

## What

JSON structured logger with log levels (debug/info/warn/error), context binding, child loggers with inherited context, and ISO 8601 timestamps. Zero external dependencies. Designed for consistent agent observability across daemon, orchestration, and tool packages.

## File

`packages/tools/structured-logger.ts` (~120 lines)

## Status

**quarantine** - new file, untested in CI, not wired into agent or daemon yet.

## API

```ts
import { Logger, logger } from './packages/tools/structured-logger.ts';

// Default process-level logger
logger.info("agent started");
logger.warn("memory usage high", { usedMb: 512 });
logger.error("tool failed", { tool: "bash", code: 1 });

// Custom logger with base context
const root = new Logger({
  level: "debug",
  context: { app: "8gent", version: "1.0.0" },
});

// Child logger - inherits context, adds scope
const child = root.child("orchestration", { worktree: "wt-1" });
child.info("worktree spawned");
// {"timestamp":"...","level":"info","message":"worktree spawned","context":{"app":"8gent","version":"1.0.0","scope":"orchestration","worktree":"wt-1"}}

// Bind context fields without creating a named scope
const bound = root.withContext({ requestId: "abc-123" });
bound.debug("processing request");

// Runtime level adjustment
root.setLevel("warn");
root.debug("this is suppressed");
root.warn("this appears");
```

## Output format

Each log line is a single-line JSON object:

```json
{
  "timestamp": "2026-03-25T12:00:00.000Z",
  "level": "info",
  "message": "worktree spawned",
  "context": {
    "app": "8gent",
    "scope": "orchestration",
    "worktree": "wt-1"
  }
}
```

## Integration path

- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Replace ad-hoc `console.log` calls in `packages/daemon/` with child loggers
- [ ] Replace ad-hoc logging in `packages/orchestration/` with child loggers
- [ ] Inject session ID into logger context at agent loop start in `packages/eight/agent.ts`
- [ ] Add optional file sink (append to `.8gent/logs/agent.jsonl`)
- [ ] Add tests: level filtering, context inheritance, child scoping
- [ ] Consider structured error fields (`err.message`, `err.stack`) as first-class fields

## Why quarantined

New file with no tests and no integration. Needs adoption across packages and a test suite before graduating to a first-class tool.
