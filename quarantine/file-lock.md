# Tool: file-lock

## Description

Advisory file locking for cross-process synchronization. Uses a `.lock` sidecar file containing the owner PID and timestamp. Stale locks (owner PID no longer running, or older than configurable TTL) are automatically broken before retry. Includes exponential backoff on contention and an auto-release `withLock` scope helper.

## Status

**quarantine** - implemented, not yet wired into the agent tool registry or any package exports.

## Integration Path

1. Export from `packages/tools/index.ts` once reviewed.
2. Use in `packages/memory/` to guard concurrent SQLite writes from multiple agent sessions.
3. Use in `packages/orchestration/` to serialize shared workspace mutations across worktree workers.
4. Candidate for replacing ad hoc manual lock files elsewhere in the codebase.

## API

```ts
import { lockFile, unlockFile, isLocked, withLock } from "./file-lock";

// Preferred - auto-releases on throw
await withLock("/path/to/file", async () => {
  // exclusive region
});

// Manual acquire/release
await lockFile("/path/to/file", { timeout: 3000, retryInterval: 50, staleAfter: 30000 });
try {
  // exclusive region
} finally {
  unlockFile("/path/to/file");
}

// Check without acquiring
if (isLocked("/path/to/file")) {
  console.log("busy");
}
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `5000` | Max ms to wait before throwing |
| `retryInterval` | `number` | `50` | Initial retry delay (ms), doubles each attempt, cap 500ms |
| `staleAfter` | `number` | `60000` | Max lock age (ms) before treating as stale |

## Stale Detection

A lock is considered stale if either:
- The owning PID is no longer alive (`process.kill(pid, 0)` throws)
- The lock file is older than `staleAfter` ms

Stale locks are removed atomically before the next acquisition attempt.

## Notes

- Lock files are named `<target>.lock` and live alongside the target file.
- Only the process that created the lock can release it via `unlockFile`.
- `withLock` is the recommended API - guarantees cleanup in all exit paths.
- Not suitable for NFS or distributed filesystems - local use only.
