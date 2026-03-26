# work-queue

Priority work queue with concurrency control.

## Requirements
- WorkQueue with concurrency and priority levels (0-9)
- add(fn, priority?) returns Promise
- High-priority tasks run before low
- pause()/resume() block new task starts
- getStats() returns pending, running, completed

## Status

Quarantine - pending review.

## Location

`packages/tools/work-queue.ts`
