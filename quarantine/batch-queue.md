# batch-queue

Coalesce multiple individual requests into batched calls.

## Requirements
- BatchQueue<T, R>(batchFn, options) collects items
- add(item) returns Promise<R>
- Flushes on maxSize or maxWait timeout
- batchFn receives items array and returns results array
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/batch-queue.ts`
