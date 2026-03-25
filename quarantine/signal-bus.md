# Quarantine: signal-bus

**Status:** Quarantine - evaluate before promoting to core.

## What it is

A minimal reactive signal system (~130 lines). Modelled after Preact Signals / SolidJS primitives but with zero dependencies and no DOM coupling - works in any Bun/Node/browser context.

## API

| Export | Signature | Purpose |
|--------|-----------|---------|
| `signal` | `signal<T>(initial: T): Signal<T>` | Create a mutable reactive value |
| `computed` | `computed<T>(fn: () => T): Computed<T>` | Derive a read-only value from signals |
| `effect` | `effect(fn: () => void): () => void` | Side-effect that re-runs on signal change, returns dispose fn |
| `batch` | `batch<T>(fn: () => T): T` | Group writes - flush effects once at the end |

## Usage

```ts
import { signal, computed, effect, batch } from '../packages/tools/signal-bus';

const count  = signal(0);
const double = computed(() => count() * 2);

const dispose = effect(() => {
  console.log(`count=${count()}, double=${double()}`);
});

count.set(1);   // logs: count=1, double=2
count.set(2);   // logs: count=2, double=4

// batch - one flush for both writes
batch(() => {
  count.set(10);
  count.set(20);
}); // logs once: count=20, double=40

dispose(); // stop listening
```

## Why quarantine

- Pattern is proven (Preact Signals, SolidJS, Svelte stores) but unproven in this codebase.
- No consumers yet - needs a real use-case before promoting.
- Edge cases around circular computed chains not tested.

## Promote when

- At least one package (`packages/memory/`, `apps/tui/`) migrates a slice of state to signals.
- Circular dependency guard added (depth counter).
- Benchmarked against current manual pub/sub in `packages/tools/event-aggregator.ts`.

## Size

~130 lines. Zero dependencies.
