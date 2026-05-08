# Quarantine: Graceful Shutdown

## Status: Quarantine (not wired into index.ts yet)

## What

`packages/daemon/graceful-shutdown.ts` - a standalone module that handles SIGTERM/SIGINT for the Eight daemon process.

## Problem

The existing shutdown logic in `packages/daemon/index.ts` is inline and minimal. It saves state and stops services but does not notify connected WebSocket clients, does not explicitly close agent sessions, has no timeout guard against hung cleanup, and does not flush structured log entries.

## What this module does

Shutdown sequence (in order):

1. **Save state** - writes active session metadata to `daemon-state.json` so sessions can resume after restart
2. **Notify clients** - emits `session:end` with reason `daemon-shutdown` for every active session, so WebSocket clients get a clean disconnect signal
3. **Close sessions** - calls `pool.destroySession()` on every active session to release agent resources
4. **Stop background services** - stops heartbeat and cron scheduler
5. **Stop WebSocket server** - closes the Bun HTTP/WS server
6. **Flush logs** - writes a final structured log entry and clears the event bus
7. **Exit** - `process.exit(0)`

Safety: a 10-second hard timeout forces `process.exit(1)` if any step hangs.

## API

```ts
import { registerShutdownHandlers } from "./graceful-shutdown";

// Call once after creating pool and server
registerShutdownHandlers({
  pool,
  server,
  statePath: `${DATA_DIR}/daemon-state.json`,
  logPath: `${DATA_DIR}/daemon.log`,
});
```

## Integration (when leaving quarantine)

Replace the inline `shutdown()` function and `process.on` calls in `packages/daemon/index.ts` with a single `registerShutdownHandlers()` call.

## Files

- `packages/daemon/graceful-shutdown.ts` (~80 lines)
- `quarantine/graceful-shutdown.md` (this file)

## Not doing

- Modifying `index.ts` - this is quarantined, integration is a separate step
- Adding retry logic for state saves - sync write is sufficient for shutdown
- WebSocket close frames - the event bus notification is enough for clients to react
