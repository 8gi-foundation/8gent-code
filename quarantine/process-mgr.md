# Process Manager

**Status:** Quarantine
**Location:** `packages/tools/process-manager.ts`
**Lines:** ~110

## Problem

Daemon and background tasks need a unified way to spawn, monitor, restart, and kill child processes. Currently each consumer handles this ad-hoc.

## What It Does

- **Spawn** named child processes with stdout/stderr streaming
- **Auto-restart** on crash with configurable max retries and delay
- **Log capture** - rolling buffer of last 500 lines per process
- **Graceful kill** - SIGTERM first, SIGKILL after timeout
- **Status/list** - query running state, restart count, logs

## API

```ts
import { ProcessManager } from "packages/tools/process-manager";

const pm = new ProcessManager();

// Spawn a background task
pm.spawn("daemon", {
  command: ["bun", "run", "packages/daemon/index.ts"],
  restartOnCrash: true,
  maxRestarts: 5,
  restartDelayMs: 2000,
  onStdout: (line) => console.log(line),
  onExit: (code, id) => console.log(`${id} exited: ${code}`),
});

// Check status
pm.status("daemon"); // { running: true, restarts: 0, logs: [...] }

// List all
pm.list(); // [{ id: "daemon", running: true, restarts: 0 }]

// Kill gracefully
await pm.kill("daemon");

// Kill everything
await pm.killAll();
```

## Integration Points

- `packages/daemon/` - vessel daemon lifecycle
- `packages/orchestration/` - worktree sub-agent processes
- `packages/music/` - mpv/afplay background playback

## Graduation Criteria

- [ ] Used by at least one consumer (daemon or orchestration)
- [ ] Integration test with a real child process
- [ ] Error handling validated under process starvation
