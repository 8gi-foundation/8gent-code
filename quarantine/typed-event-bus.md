# Quarantine: typed-event-bus

**Status:** Under review - not wired into production code.

**File:** `packages/orchestration/typed-event-bus.ts`

---

## What it is

A zero-dependency, type-safe event bus for coordinating communication between agent components, tools, and orchestration layers inside the 8gent kernel.

---

## API

### `new TypedEventBus<Events>(options?)`

`Events` is a map of `{ eventName: payloadType }`. `options.historyLimit` defaults to 100.

### `.on(event, handler)` - subscribe
### `.once(event, handler)` - subscribe once, auto-removes after first fire
### `.onWildcard(handler)` - catch all events; handler receives `{ event, payload }`
### `.off(event, handler)` - remove a specific handler
### `.emit(event, payload)` - fire event, awaits all async handlers
### `.next(event)` - returns a Promise resolving on next emission
### `.clear(event?)` - remove all listeners for event, or all listeners
### `.getHistory(event?)` - returns buffered history, optionally filtered
### `.clearHistory()` - flush history buffer
### `.listenerCount(event?)` - count active listeners

---

## Usage example

```typescript
import { TypedEventBus } from '../packages/orchestration/typed-event-bus';

type AgentEvents = {
  'tool:start': { toolName: string; args: unknown };
  'tool:done': { toolName: string; result: unknown; durationMs: number };
  'session:end': { sessionId: string };
};

const bus = new TypedEventBus<AgentEvents>({ historyLimit: 200 });

// Typed subscription
bus.on('tool:done', ({ toolName, durationMs }) => {
  console.log(`${toolName} finished in ${durationMs}ms`);
});

// One-shot
bus.once('session:end', ({ sessionId }) => {
  console.log(`Session ${sessionId} closed`);
});

// Wildcard observer
bus.onWildcard(({ event, payload }) => {
  metrics.record(event, payload);
});

// Async emit - waits for all handlers to settle
await bus.emit('tool:start', { toolName: 'bash', args: {} });

// Inspect history
const toolHistory = bus.getHistory('tool:done');
```

---

## Integration candidates

- `packages/orchestration/worktree-pool.ts` - emit worktree lifecycle events
- `packages/eight/agent.ts` - replace ad-hoc callbacks with typed events
- `packages/memory/store.ts` - emit memory consolidation events
- `packages/validation/` - emit checkpoint/revert events

---

## Quarantine checklist

- [ ] Benchmarked against existing callback patterns in `packages/orchestration/`
- [ ] Confirmed no circular import risk with target integration points
- [ ] Reviewed by at least one other contributor
- [ ] Wire-up PR created after this clears quarantine
