# task-queue-v2

**Tool name:** task-queue-v2
**File:** `packages/tools/task-queue-v2.ts`
**Status:** quarantine

## Description

Self-contained async task queue with dead letter queue (DLQ), replay, configurable retry/backoff, and concurrency control. Failed tasks that exhaust their retry budget are moved to the DLQ and can be replayed individually without losing the original payload.

| Export | Type | Notes |
|--------|------|-------|
| `TaskQueue<T>` | class | Main queue class |
| `enqueue(payload, options?)` | method | Adds task. Returns assigned id. |
| `process(handler)` | method | Registers async handler and starts processing. Call once. |
| `replay(dlqItemId)` | method | Re-enqueues a DLQ item by id with a fresh retry counter. Returns `true` if found. |
| `pause()` | method | Pauses dequeuing. In-flight tasks complete. |
| `resume()` | method | Resumes dequeuing. |
| `deadLetterQueue` | getter | Read-only view of all DLQ entries. |
| `stats()` | method | Returns `TaskQueueStats`: pending, inFlight, processed, failed, dlqSize, paused. |
| `TaskItem<T>` | interface | `{ id, payload, attempts, maxRetries, enqueuedAt, lastError? }` |
| `DLQItem<T>` | interface | Extends `TaskItem<T>` with `failedAt` and `finalError`. |
| `TaskQueueOptions` | interface | `{ concurrency?, maxRetries?, backoffMs? }` |

### Retry and backoff

Each task carries its own `maxRetries` counter (defaults to the queue-level value). On failure the task is re-queued at the front of the pending list after an exponential backoff delay: `backoffMs * 2^(attempts-1)`. Once `attempts >= maxRetries` the task is moved to the DLQ and never retried automatically.

### Dead letter queue

DLQ items preserve the full original payload, attempt count, and the final error message. `replay(id)` re-enqueues with a fresh attempt counter - useful after fixing a transient downstream issue.

## Integration path

1. **Tool dispatcher** - `packages/eight/agent.ts` can route tool calls through TaskQueue to cap concurrent tool I/O and automatically retry flaky shell or network tools.
2. **Kernel training batches** - `packages/kernel/training.ts` GRPO batch collection benefits from retry/backoff around model API calls and DLQ inspection on persistent failures.
3. **Memory consolidation** - `packages/memory/store.ts` background consolidation jobs can be queued with low concurrency and replayed if embedding calls fail transiently.
4. **Proactive opportunity pipeline** - `packages/proactive/` bounty scan results can be queued for processing with DLQ capture of parse failures.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test surface

```ts
const q = new TaskQueue<string>({ concurrency: 2, maxRetries: 2, backoffMs: 100 });

let calls = 0;
q.process(async (payload) => {
  calls++;
  if (calls === 1) throw new Error("transient");
  console.log("handled:", payload);
});

q.enqueue("hello");
q.enqueue("world");

// After processing, stats():
// { pending: 0, inFlight: 0, processed: 2, failed: 0, dlqSize: 0, paused: false }

// Force to DLQ
const q2 = new TaskQueue<string>({ maxRetries: 1, backoffMs: 0 });
q2.process(async () => { throw new Error("always fails"); });
q2.enqueue("bad-task");
// dlq: [{ id: "task-...", finalError: "always fails", ... }]

// Replay
q2.replay(q2.deadLetterQueue[0].id);
```
