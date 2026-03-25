# async-lock

## Tool Name
`async-lock`

## Description
Async mutex and read-write lock primitives for safe concurrent access control in TypeScript. Provides:

- **Mutex** - exclusive lock with `acquire`, `release`, and `runExclusive`. One holder at a time, FIFO queue for waiters.
- **RWLock** - shared/exclusive lock with `acquireRead`, `acquireWrite`, `runRead`, `runWrite`. Multiple concurrent readers, write-exclusive. Writers are prioritised over new readers to prevent starvation.
- **Timeout support** - both primitives accept an optional `timeoutMs` argument; throws `TimeoutError` if the lock cannot be acquired in time.

## Status
`quarantine` - standalone, tested conceptually, not yet wired into any agent package.

## Integration Path
1. Import into `packages/eight/agent.ts` or `packages/orchestration/` where concurrent sub-agent tool calls need serialised access to shared state (e.g. memory writes, file edits).
2. Use `RWLock` around the memory store: readers (query) run concurrently, writers (insert/update) are exclusive.
3. Use `Mutex` around atomic file operations in `packages/validation/` checkpoint writes.
4. Wire `TimeoutError` into the agent's error-handling layer so lock contention surfaces cleanly in the TUI.

## File
`packages/tools/async-lock.ts`

## Exports
- `Mutex`
- `RWLock`
- `TimeoutError`
