# Quarantine: resource-tracker

**Status:** Quarantined - awaiting integration decision
**Package:** `packages/tools/resource-tracker.ts`
**Size:** ~130 lines

## What it does

Tracks allocated resources (file handles, subprocesses, timers, DB connections, etc.) and ensures cleanup runs on exit or when a scope is disposed.

## API

```ts
import { ResourceTracker, globalTracker } from "./packages/tools/resource-tracker";

// Create a tracker with auto-exit hooks
const tracker = new ResourceTracker();

// Track a resource with a cleanup function
const handle = tracker.track(openFile("log.txt"), () => handle.close(), "log-file");

// Remove from tracking without cleanup
tracker.untrack(handle);

// Register a global teardown hook (runs after all resource cleanups)
tracker.onDispose(async () => { await db.disconnect(); });

// Dispose everything (LIFO order), idempotent
await tracker.disposeAll();

// Nested scope - child disposes first when parent disposes
const scope = tracker.scope();
scope.track(tempDir, () => rm(tempDir, { recursive: true }));
await scope.disposeAll(); // only cleans scope's resources
```

## Design decisions

- **LIFO cleanup order** - last acquired, first released. Mirrors structured resource acquisition.
- **Async cleanup** - cleanup functions may be async. Errors are caught and logged, not rethrown.
- **Idempotent** - `disposeAll()` is safe to call multiple times.
- **Nested scopes** - child trackers are themselves tracked by the parent. Disposing parent disposes all children.
- **Auto-exit** - registers `SIGINT`, `SIGTERM`, `uncaughtException`, and `exit` handlers on the root tracker.
- **No external deps** - pure Node/Bun, zero imports.

## Why quarantined

- Needs integration review with `packages/tools/` export barrel before wiring into agent loop.
- Process exit handler conflicts possible if multiple root trackers are instantiated - needs audit.
- Async cleanup on `process.on('exit')` is fire-and-forget (Node limitation); only `SIGINT`/`SIGTERM` paths are truly async-safe.

## Integration path

1. Add export to `packages/tools/index.ts`
2. Wire into `packages/eight/agent.ts` - call `tracker.track()` for subprocesses, temp files, and open streams
3. Replace ad-hoc cleanup in `packages/orchestration/worktree-pool.ts` with scoped trackers
4. Write `packages/tools/resource-tracker.test.ts`
