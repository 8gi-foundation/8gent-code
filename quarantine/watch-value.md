# Quarantine: watch-value

**Status:** Quarantine - under review before wiring into core

**File:** `packages/tools/watch-value.ts`

---

## What it does

`Watchable<T>` wraps any value and fires registered callbacks when the value changes. Two detection modes:

- **Setter-based** - call `.set(newValue)` and all `onChange` listeners fire synchronously.
- **Poll-based** - call `.watch(getter, callback, intervalMs?)` to poll an external source on a timer.

---

## API

```ts
import { Watchable, watch } from "./packages/tools/watch-value";

// Setter-based
const w = new Watchable(0);
const unsub = w.onChange((next, prev) => console.log(next, prev));
w.set(1); // fires callback
unsub();  // remove listener

// Poll-based
const external = watch(
  () => someExternalRef.value,
  (next, prev) => console.log("changed:", prev, "->", next),
  500 // poll every 500ms
);
external.dispose(); // stop all polling

// Mixed: setter + poll watchers on same Watchable
const ww = new Watchable("idle");
ww.onChange((v) => console.log("state:", v));
const stopPoll = ww.watch(() => readStateFromSomewhere(), (n, p) => {}, 250);
ww.set("active"); // fires onChange
stopPoll();       // clear poll only
ww.dispose();     // clear everything
```

---

## Design decisions

- **Strict equality (`===`)** for change detection. Callers must produce new references for objects/arrays.
- **Synchronous callbacks** on setter-based changes - predictable ordering, no async surprises.
- **Isolated errors** - a throwing subscriber does not block others; errors are logged to console.
- **Poll watchers propagate to onChange subscribers** - one poll source can fan out to many listeners.
- **`dispose()`** clears all subscriptions and intervals, safe to call multiple times.

---

## Integration candidates

- `packages/self-autonomy/` - watch config/preference values for live adaptation
- `packages/eight/agent.ts` - watch abort signal or session state
- `apps/tui/` - reactive value binding for terminal UI state
- `packages/memory/` - watch memory health metrics

---

## Promotion criteria

- [ ] At least one real consumer wired in codebase
- [ ] Test file added (`watch-value.test.ts`)
- [ ] Decision on whether to support deep-equality option for objects
