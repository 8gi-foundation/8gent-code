# Tool: Value Store

## Description

Observable value store with change subscriptions, bounded history, and in-place transform. `ValueStore<T>` wraps any value with reactive get/set semantics - subscribers fire on every change, history is retained up to a configurable depth, and `transform()` applies a function atomically to the current value.

## Status

**quarantine** - implemented, not yet wired into the agent tool registry or any package exports.

## Integration Path

1. Export from `packages/tools/index.ts` once reviewed.
2. Use in agent session state to track mid-session variable changes with rollback capability (pairs with `StateHistory`).
3. Candidate for replacing ad hoc mutable refs in `packages/eight/agent.ts` where change notifications are needed.
4. Combine with `value-transformer.ts` - pipe `transform()` output into `store.set()` for validated reactive state.

## API

```ts
import { ValueStore } from "../packages/tools/value-store.ts";

// Create a store with an initial value
const store = new ValueStore(0, { maxHistory: 10 });

// Subscribe to changes
const unsub = store.subscribe((val, prev) => {
  console.log(`changed: ${prev} -> ${val}`);
});

// Set values
store.set(1);   // logs "changed: 0 -> 1"
store.set(2);   // logs "changed: 1 -> 2"
store.set(2);   // no-op - value unchanged, no subscriber call

// In-place transform
store.transform((n) => n * 10); // sets to 20, logs "changed: 2 -> 20"

// Read current and history
store.get();        // 20
store.previous();   // 2
store.history();    // [0, 1, 2]
store.history(2);   // [1, 2]  (last 2 entries)

// Reset to initial (0) or a new value
store.reset();      // back to 0, clears history
store.reset(100);   // set to 100, clears history

// Unsubscribe
unsub();
store.subscriberCount(); // 0
```

## Notes

- `set()` is a no-op on strict equality (`===`). No spurious subscriber calls.
- Subscribers that throw are silently swallowed - they must not throw.
- `reset()` without an argument returns to the value passed to the constructor.
- History stores past values oldest-first. `previous()` is a shortcut for the last entry.
- For undo/redo semantics, prefer `StateHistory` - this store is optimized for reactivity, not cursor navigation.
