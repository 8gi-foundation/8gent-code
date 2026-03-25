# Quarantine: state-container

## Status

`quarantine` - pending review before promotion to active use.

## What

Minimal Zustand-style reactive state container in ~120 lines. No dependencies.

## API

```ts
const store = createStore({ count: 0, user: "eight" });

// Read state
store.getState();                         // { count: 0, user: "eight" }

// Partial merge
store.setState({ count: 1 });

// Updater function
store.setState((prev) => ({ count: prev.count + 1 }));

// Subscribe to all changes
const unsub = store.subscribe((state, prev) => {
  console.log("changed", state);
});
unsub(); // stop listening

// Selector subscription - fires only when slice changes
const unsubSlice = store.subscribeSelector(
  (s) => s.count,
  (count, prev) => console.log("count changed", prev, "->", count)
);

// Tear down
store.destroy();
```

## File

`packages/tools/state-container.ts`

## Why quarantine

No existing consumer. Needs a real use-case before wiring into agent or TUI state.

## Promotion criteria

- At least one package or screen uses it as a replacement for ad-hoc state
- Unit tests covering setState (partial + updater), subscribe, subscribeSelector, and destroy
- Benchmarked against direct object mutation to confirm negligible overhead
