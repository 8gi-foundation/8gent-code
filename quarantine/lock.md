# lock

Async mutex and semaphore for coordinating concurrent access.

## Requirements
- Mutex class: acquire() -> Promise<release()>, withLock(fn)
- ReadWriteLock: acquireRead(), acquireWrite()
- Semaphore(n): acquire() blocks when all permits taken
- Timeout option on acquire
- No dependencies - pure async/await

## Status

Quarantine - pending review.

## Location

`packages/tools/lock.ts`
