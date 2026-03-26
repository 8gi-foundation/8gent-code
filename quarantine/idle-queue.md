# idle-queue

Execute tasks during idle time (requestIdleCallback-inspired).

## Requirements
- IdleQueue enqueues low-priority tasks
- add(fn, priority?) queues function
- flush() runs queued tasks immediately
- start()/stop() for auto-drain mode
- Zero dependencies (no browser API required)

## Status

Quarantine - pending review.

## Location

`packages/tools/idle-queue.ts`
