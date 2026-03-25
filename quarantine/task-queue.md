# Quarantine: task-queue

**Package:** `packages/orchestration/task-queue.ts`
**Status:** Quarantine - awaiting review before wiring into any existing package

---

## What it does

Priority-based task queue with:

- **Concurrency limit** - configurable max parallel tasks (default 4)
- **Priority ordering** - tasks sorted 1 (highest) to 5 (lowest) at enqueue time
- **Retry with exponential backoff** - configurable max retries and base delay
- **Task states** - `pending | running | done | failed | cancelled`
- **Event emitter** - typed events: `enqueued`, `started`, `done`, `failed`, `retry`, `cancelled`, `drained`
- **Per-task timeout** - optional `timeoutMs` races against a `Promise.reject`
- **Drain/stop** - `drain()` resolves when queue empties; `stop()` halts intake then drains
- **Zero dependencies** - no imports outside TypeScript stdlib

---

## API

```ts
import { TaskQueue } from "./packages/orchestration/task-queue";

const queue = new TaskQueue({ concurrency: 4 });

// Enqueue a task
const task = queue.enqueue(
  async () => fetchSomething(),
  { priority: 1, maxRetries: 3, retryBaseMs: 500, timeoutMs: 10_000 }
);

// Listen for events
const off = queue.on((event) => {
  if (event.type === "done") console.log("done", event.task.result);
  if (event.type === "failed") console.error("failed", event.task.error);
});

// Cancel a pending task
queue.cancel(task.id);

// Wait until empty
await queue.drain();

// Stats
console.log(queue.stats); // { pending, running, done, failed, cancelled }

// Stop accepting new tasks and drain
await queue.stop();
```

---

## Integration candidates

These packages have no queue primitive and could benefit:

| Package | Use case |
|---------|----------|
| `packages/orchestration/worktree-pool.ts` | Replace ad-hoc concurrency limit with TaskQueue |
| `packages/memory/store.ts` | Consolidation job queue (already has lease-based approach - evaluate fit) |
| `packages/proactive/` | Bounty scan pipeline - rate-limited API calls with retry |
| `packages/kernel/training.ts` | GRPO batch submission queue |

---

## Review checklist

- [ ] Unit tests written and passing
- [ ] Retry storms checked under high-concurrency conditions
- [ ] `timeoutMs` behavior verified against real async ops
- [ ] `drain()` promise resolves correctly with mixed cancel/fail/done outcomes
- [ ] Wire into one integration candidate and verify end-to-end
- [ ] Export added to `packages/orchestration/index.ts` after review
