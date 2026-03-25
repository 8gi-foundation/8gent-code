# async-queue

**Tool name:** AsyncQueue
**File:** `packages/tools/async-queue.ts`
**Status:** quarantine
**Lines:** ~145

## Description

Async FIFO queue with blocking dequeue and capacity-based backpressure. Designed for producer-consumer patterns inside agent pipelines where tasks are produced faster than they are consumed.

Key capabilities:
- `enqueue(item)` - blocks (backpressure) when queue is at capacity
- `dequeue()` - blocks until an item is available
- `peek()` - inspect the front item without consuming it
- `drain()` - await until the queue is empty
- `close()` - signal end-of-stream; pending dequeues resolve with `undefined`
- `for await ... of queue` - async iterator support

## Integration Path

1. **Agent tool bus** - route tool call results through a bounded queue so the agent loop processes one at a time without overwhelming the executor
2. **Streaming ingestion** - buffer incoming token chunks from a model stream before display
3. **Worktree task dispatch** (`packages/orchestration/`) - feed tasks to `WorktreePool` workers with natural backpressure instead of unbounded arrays
4. **Memory consolidation** (`packages/memory/`) - replace the lease-based job queue with a typed `AsyncQueue<ConsolidationJob>`

## Usage

```typescript
import { AsyncQueue } from "../packages/tools/async-queue.ts";

const q = new AsyncQueue<string>(10); // capacity 10

// Producer
(async () => {
  for (const item of items) {
    await q.enqueue(item); // blocks if full
  }
  q.close();
})();

// Consumer
for await (const item of q) {
  await process(item);
}
```
