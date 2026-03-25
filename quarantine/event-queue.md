# Quarantine: event-queue

**Status:** Quarantine (not wired into main agent loop)
**Package:** `packages/tools/event-queue.ts`
**Size:** ~150 lines, single file, zero dependencies

---

## What it does

`EventQueue<T>` is a typed, in-process ordered event queue with:

- **Priority ordering** - higher `priority` events processed first; ties broken by `deliverAt`
- **Delayed delivery** - `delayMs` option holds events until the target epoch; `process()` skips them
- **Deduplication window** - `dedupKey` + `dedupWindowMs` silently drops duplicates within the window
- **Max size guard** - throws when `maxSize` is exceeded (default 1000)
- **Dead letter handling** - events that exceed `maxRetries` (default 3) move to `deadLetterQueue()`
- **Retry on failure** - handler errors leave the event in queue for the next `process()` call

---

## API

```ts
import { EventQueue } from './packages/tools/event-queue.ts';

const q = new EventQueue<MyEvent>({ maxSize: 500, maxRetries: 3 });

// enqueue immediately
q.enqueue(payload);

// enqueue with options
q.enqueue(payload, {
  priority: 10,
  delayMs: 2000,
  dedupKey: 'user:123:action',
  dedupWindowMs: 10_000,
});

// process ready events
const count = await q.process(async (payload) => {
  await handleEvent(payload);
});

// inspect
q.pending();         // total in queue
q.ready();           // ready to process now
q.deadLetterQueue(); // failed events
q.clearDeadLetters();
q.drain();           // empty queue, return all events
```

---

## Why quarantine

Not wired anywhere yet. Candidate integration points:

- Tool call queue in `packages/eight/agent.ts` (rate-limit / backpressure)
- Proactive agent task queue in `packages/proactive/`
- Orchestration message bus between worktrees in `packages/orchestration/`

Pull out of quarantine when one of these integration points is actively needed.

---

## Constraints

- In-process only - not persistent. Queue is lost on restart.
- No concurrent `process()` calls - single-threaded by design (Bun).
- Dedup registry is not size-bounded - prune runs on every `process()` call.
