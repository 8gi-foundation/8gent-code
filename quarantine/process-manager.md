# quarantine: process-manager

**Status:** Quarantine - not wired into any agent flow yet.
**File:** `packages/tools/process-manager.ts`

---

## What it does

`ProcessManager` starts, stops, and restarts child processes as named background
daemons. It tracks each process by a unique name, polls health via OS signal 0,
tails stdout/stderr into an in-memory ring buffer, and optionally writes logs
to `~/.8gent/process-logs/<name>.log`.

## Why it exists

The daemon package (`packages/daemon/`) manages an `AgentPool` via a single
long-lived Fly.io process. Several upcoming features (music player, kernel
training proxy, worktree subprocesses) need short-lived named processes that
can be started and stopped independently - without coupling to the daemon
lifecycle or adding external dependencies.

## Core constraint

Zero external dependencies. Node/Bun built-ins only (`child_process`, `node:fs`,
`node:os`, `node:path`).

## API

```ts
import { ProcessManager } from "./packages/tools/process-manager";
const pm = new ProcessManager();

const { pid } = await pm.start({ name: "my-server", command: ["node", "server.js"], persistLog: true });
const h = pm.health("my-server");      // { status, pid, uptime, pidAlive }
const lines = pm.logs("my-server", 50); // last 50 log lines
await pm.stop("my-server");            // SIGTERM -> SIGKILL after 5s
await pm.restart({ name: "my-server", command: ["node", "server.js"] });
pm.list();                             // ProcessRecord[]
await pm.stopAll(); pm.dispose();
```

## CLI

```sh
bun packages/tools/process-manager.ts start  my-server node server.js
bun packages/tools/process-manager.ts health my-server
bun packages/tools/process-manager.ts logs   my-server --tail=50
bun packages/tools/process-manager.ts stop   my-server
bun packages/tools/process-manager.ts list
```

## Key behaviors

| Behavior | Detail |
|----------|--------|
| PID tracking | `process.kill(pid, 0)` - no deps |
| Health polling | Default 5s. Marks `crashed` if pid gone |
| Log buffer | Ring buffer (default 500 lines). `[ISO ts] stdout/stderr: ...` |
| Disk log | Optional append to `~/.8gent/process-logs/<name>.log` |
| Stop | SIGTERM first, SIGKILL after `killTimeoutMs` (default 5s) |
| PID files | `savePidFile` / `loadPidFile` for cross-process persistence |
| Restart count | `ProcessRecord.restarts` incremented by `restart()` |

## Integration candidates

- `packages/daemon/` - agent subprocess lifecycle
- `packages/music/` - named mpv handles
- `packages/kernel/proxy.ts` - training proxy process
- `packages/orchestration/` - worktree subprocesses

## Not doing

- Auto-restart on crash (callers decide policy)
- Cross-machine management
- Process groups or cgroups
- Resource limits

## Promotion criteria

1. Integration test: start/health/logs/stop a real process.
2. Confirm log rotation interop with `packages/tools/log-rotation.ts`.
3. Decide singleton ownership (daemon vs orchestration vs tools).
