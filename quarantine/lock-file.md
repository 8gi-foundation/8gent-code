# lock-file

**Status:** quarantine

## Description

Filesystem-based locking utility for preventing concurrent access to shared resources. Uses atomic file creation (`O_EXCL`) for race-free acquisition, stale lock detection by PID liveness, exponential backoff retries, and auto-release on process exit/signal.

## API

| Export | Signature | Purpose |
|--------|-----------|---------|
| `acquireLock` | `(path, options?) => Promise<() => void>` | Acquire lock, returns a release function |
| `releaseLock` | `(path) => void` | Release lock held by current PID |
| `isLocked` | `(path) => boolean` | Check if a lock is currently active |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | `10` | Attempts before throwing |
| `initialBackoff` | `50ms` | Starting retry delay (doubles each attempt) |
| `maxBackoff` | `2000ms` | Retry delay cap |
| `staleAge` | `30000ms` | Age threshold to consider a lock stale |
| `metadata` | `undefined` | Extra data written into the lock file |

## Integration Path

- `packages/orchestration/` - worktree pool can use this to prevent double-checkout of the same branch
- `packages/memory/store.ts` - wrap write operations to guard against concurrent agent writes to SQLite WAL
- `packages/tools/index.ts` - export once stable

## Location

`packages/tools/lock-file.ts`
