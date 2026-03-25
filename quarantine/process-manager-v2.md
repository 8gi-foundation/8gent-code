# Quarantine: process-manager-v2

**Status:** Quarantined - awaiting review before wiring into main agent loop.

**File:** `packages/tools/process-manager-v2.ts`

## What it does

`ProcessManager` manages child processes (spawned via Node's `child_process.spawn`) with:

- **spawn(name, cmd, args, options)** - starts a named process
- **stop(name)** - SIGTERM + removes from registry
- **restart(name)** - kills and re-launches in place
- **health(name)** - returns status, PID, restart count, uptime in ms
- **logs(name, lines?)** - tail N lines from rolling log buffer (default: all)
- **listAll()** - snapshot of all tracked processes
- **stopAll()** - graceful bulk shutdown

## Auto-restart behavior

Set `autoRestart: true` in options. Triggers only on non-zero exit with no signal (crash detection). Respects `maxRestarts` (default 5) and `restartDelayMs` (default 1000ms). Disabled automatically on explicit `stop()`.

## Log capture

stdout and stderr are captured into a rolling in-memory buffer (default 200 lines). Each line is timestamped. stderr lines are prefixed `[stderr]`.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `cwd` | inherited | working directory |
| `env` | `{}` | extra env vars merged onto `process.env` |
| `autoRestart` | `false` | restart on crash |
| `maxRestarts` | `5` | max auto-restart attempts |
| `restartDelayMs` | `1000` | ms to wait before restart |
| `maxLogLines` | `200` | rolling log buffer size |

## Usage example

```ts
import { ProcessManager } from "./packages/tools/process-manager-v2";

const pm = new ProcessManager();

pm.spawn("api", "node", ["server.js"], { autoRestart: true, maxRestarts: 3 });

console.log(pm.health("api"));
// { status: "running", pid: 12345, restarts: 0, uptime: 42 }

console.log(pm.logs("api", 10));

pm.restart("api");
pm.stopAll();
```

## Constraints

- In-memory only - state is lost on process manager restart.
- No persistence, no cross-process registry.
- Designed for use within a single Node/Bun runtime (e.g. daemon, test harness, dev orchestrator).

## Review checklist

- [ ] Confirm SIGTERM handling is sufficient for target processes (may need SIGKILL fallback for stubborn procs)
- [ ] Decide if log buffer should be configurable per-line or per-byte
- [ ] Consider whether `spawn()` should throw or silently replace on duplicate name
- [ ] Evaluate whether this replaces or wraps `packages/tools/background.ts`
