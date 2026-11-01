# queue-with-priority

**Tool name:** queue-with-priority
**File:** `packages/tools/queue-with-priority.ts`
**Status:** quarantine

## Description

Self-contained async priority queue with three lanes (high, normal, low) and a configurable fairness ratio to prevent low-priority starvation.

| Export | Type | Notes |
|--------|------|-------|
| `PriorityAsyncQueue<T>` | class | Main queue class |
| `enqueue(item, priority)` | method | Adds item to the given lane. Throws if lane is full or queue is closed. |
| `dequeue()` | async method | Returns next item respecting priority and fairness. Blocks until an item is available. |
| `drain()` | method | Flushes all items in priority order. Returns array. Does not close the queue. |
| `close()` | method | Closes the queue; pending `dequeue()` calls resolve to `undefined`. |
| `Priority` | type | `"high" \| "normal" \| "low"` |
| `QueueItem<T>` | interface | `{ item, priority, enqueueTime }` |
| `PriorityQueueOptions` | interface | `{ maxPerLane?, fairnessRatio? }` |

### Fairness mechanism

After `fairnessRatio` consecutive dequeues from a high lane without serving the next lower lane, the next pick is forced to the lower lane (if it has items). Same logic applies between normal and low. Default ratio: 5. This ensures low-priority items are never indefinitely blocked by a busy high-priority producer.

## Integration Path

1. **Agent tool dispatcher** - `packages/eight/agent.ts` queues tool calls; high priority for user-blocking tools (read, write), normal for background tools (search), low for speculative prefetch.
2. **Orchestration worktree pool** - `packages/orchestration/` can prioritize user-facing sub-agent tasks over background analysis tasks.
3. **Memory consolidation** - `packages/memory/store.ts` consolidation jobs can be enqueued at low priority, yielding to episodic writes at high priority.
4. **Rate-limited provider calls** - `packages/providers/` can back-pressure API requests with a bounded-lane queue instead of a raw array.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test surface

```ts
const q = new PriorityAsyncQueue<string>({ fairnessRatio: 3 });
q.enqueue("a", "low");
q.enqueue("b", "high");
q.enqueue("c", "normal");

const first = await q.dequeue();  // { item: "b", priority: "high", ... }
const second = await q.dequeue(); // { item: "c", priority: "normal", ... }
const third = await q.dequeue();  // { item: "a", priority: "low", ... }

q.close();
const after = await q.dequeue();  // undefined
```
