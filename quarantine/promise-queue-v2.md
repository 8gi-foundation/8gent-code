# Quarantine: promise-queue-v2

**Status:** quarantine - awaiting integration decision
**File:** `packages/tools/promise-queue-v2.ts`
**Size:** ~120 lines

## What it does

Serial (or concurrent) promise queue with priority ordering. Tasks with a higher `priority` value execute before lower-priority ones. Ties preserve insertion order (stable sort via binary insert).

## API

```ts
import { PromiseQueue } from "./packages/tools/promise-queue-v2";

const q = new PromiseQueue(/* concurrency = */ 2);

// add(fn, priority?) - returns a Promise for the task result
const result = await q.add(() => fetch("/api/data"), 10);

// Introspection
q.size;      // tasks waiting
q.pending;   // tasks running
q.isPaused;  // boolean

// Flow control
q.pause();   // halt dispatch (in-flight continues)
q.start();   // resume + drain
q.clear();   // reject all waiting tasks

// Drain event
const unsub = q.onEmpty(() => console.log("queue drained"));
unsub();     // remove listener
```

## Design notes

- Priority is sorted descending (higher = first) via binary insert - O(log n) per enqueue.
- Concurrency defaults to 1 (serial). Set higher for parallel-with-limit use cases.
- `clear()` rejects waiting promises with a descriptive error - safe to use in cleanup paths.
- `onEmpty` fires only when both `size` and `pending` hit zero - not on every dequeue.
- No external dependencies.

## Integration candidates

- `packages/eight/agent.ts` - tool call dispatch queue
- `packages/orchestration/` - sub-agent task dispatch
- `packages/proactive/` - bounty scanner request batching
- Any place currently using raw `Promise.all` without backpressure

## Replaces / relates to

- `quarantine/async-queue` - simpler, no priority
- `quarantine/priority-queue` - data structure only, no async runner
- `quarantine/queue-with-priority` - older iteration, similar scope
