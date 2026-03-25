# Quarantine: event-bus-v2

**Status:** Quarantine review
**Package:** `packages/tools/event-bus-v2.ts`
**Size:** ~150 lines

## What it does

Typed event bus with namespace isolation, event history replay, and wildcard pattern matching.

## API

```ts
import { EventBus, bus } from "./packages/tools/event-bus-v2";

// Basic on/off/once/emit
bus.on("user:login", (payload) => console.log(payload));
bus.once("app:ready", () => console.log("ready"));
bus.emit("user:login", { userId: "abc" });
bus.off("user:login", handler);

// Namespaced sub-bus
const ui = bus.namespace("ui");
ui.on("modal:open", (payload) => { /* ... */ });
ui.emit("modal:open", { id: "confirm" });

// Wildcard matching
bus.on("ui:*", (payload, record) => console.log(record.event));

// Event history replay
bus.replay("user:*");           // replay all user namespace events
bus.getHistory("ui:modal:*");   // inspect history
bus.clearHistory();
```

## Design notes

- `namespace(ns)` returns a `NamespacedBus` that prefixes all events with `ns:`
- Wildcards: `*` matches any single segment or any run of characters
- History is capped at 500 events (configurable via `new EventBus({ maxHistory: N })`)
- `once` listeners are auto-removed after first invocation
- `replay()` dispatches historical records to current listeners - useful for late subscribers

## Integration candidates

- `packages/orchestration/` - cross-worktree event signaling
- `packages/self-autonomy/` - reflection lifecycle events
- `apps/tui/` - decouple UI state updates from agent loop

## Promotion checklist

- [ ] Unit tests written
- [ ] Integrated into at least one package as a trial
- [ ] No performance regression on high-frequency emit (>1000/s)
- [ ] Reviewed by a second agent session
