# quarantine: batch-processor

**Status:** quarantine - review before wiring into agent loop

## What it does

`BatchProcessor<T, R>` processes an arbitrary list of items in configurable
batches. Each batch runs concurrently; the next batch starts only after the
previous one settles.

## API

```ts
import { BatchProcessor } from "../packages/tools/batch-processor.ts";

const bp = new BatchProcessor<string, number>();

bp.onBatch((results, batchIndex, progress) => {
  console.log(`Batch ${batchIndex} done - ${progress.percent}% complete`);
});

const summary = await bp.process(items, 10, async (item, signal) => {
  // do work - signal fires if abort() was called
  return item.length;
});

console.log(summary.succeeded, summary.failed);
```

## Features

- Configurable `batchSize` - pass any positive integer
- Concurrent execution within each batch via `Promise.all`
- Per-item error collection - one failing item does not abort the batch
- `onBatch` callback with `{ processed, total, percent }` progress info
- `abort()` - stops cleanly after the current batch, sets `summary.aborted`
- `AbortSignal` passed to each item fn for cooperative cancellation

## Constraints

- Items within a batch run concurrently; ordering of results matches input order
- `batchSize < 1` throws immediately
- Does not retry failed items - caller is responsible for retry logic

## Files

- `packages/tools/batch-processor.ts` - implementation (~120 lines)

## Not doing

- No retry logic (keep it composable - wrap fn externally)
- No streaming - summary returned after all batches complete
- No persistence of partial progress across process restarts
