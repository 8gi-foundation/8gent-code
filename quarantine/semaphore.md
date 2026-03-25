# semaphore

**Tool name:** Semaphore
**Package path:** `packages/tools/semaphore.ts`
**Status:** quarantine

## Description

Async semaphore for controlling concurrent operation limits. Queues waiting tasks when the configured concurrency ceiling is reached. Supports per-acquire timeouts and exposes usage statistics for observability.

## API surface

- `new Semaphore(maxConcurrency)` - create with a positive integer limit
- `semaphore.acquire(options?)` - acquire a slot; queues if at capacity
- `semaphore.release()` - release a slot and unblock the next queued task
- `semaphore.run(fn, options?)` - preferred: wraps acquire/release automatically
- `semaphore.stats` - returns `SemaphoreStats` (active, queued, totals, timeouts)
- `semaphore.available` - boolean, true if a slot is free immediately
- `SemaphoreTimeoutError` - thrown when `timeoutMs` is exceeded before acquire

## Integration path

1. **Agent tool concurrency** - wrap `packages/eight/tools.ts` tool invocations so no more than N tools run in parallel per session.
2. **WorktreePool** - `packages/orchestration/` already limits worktrees to 4; Semaphore can replace the ad-hoc counter there.
3. **Kernel training batches** - `packages/kernel/training.ts` batch collection benefits from bounded parallelism.
4. **Memory consolidation** - `packages/memory/` background jobs can share a single low-concurrency semaphore.

## Promotion checklist

- [ ] Unit tests added under `packages/tools/__tests__/semaphore.test.ts`
- [ ] Integrated into at least one of the paths above
- [ ] `SemaphoreStats` surfaced in debugger or TUI activity monitor
- [ ] CHANGELOG.md entry added
