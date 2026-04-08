# boxed-value

Boxed mutable reference for sharing values across closures.

## What it does

`Box<T>` wraps a single mutable value and lets multiple closures share a reference to it without capturing stale copies. Mutations are propagated to subscribers synchronously. `Ref<T>` is a type alias for when the "slot" mental model fits better.

## API

```ts
import { box, ref, Box } from '../packages/tools/boxed-value';

// Create
const count = box(0);
const cursor = ref({ line: 0, col: 0 });

// Read / write
count.get();           // 0
count.set(1);          // 1
count.update(n => n + 1); // 2

// Map to a new snapshot Box
const doubled = count.map(n => n * 2);
doubled.get();         // 4 (snapshot, not live)

// Subscribe to changes
const unsub = count.subscribe((next, prev) => {
  console.log(`${prev} -> ${next}`);
});
count.set(5); // logs "2 -> 5"
unsub();      // stop listening

// Coercion
String(count);    // "5"
+count;           // 5 (via valueOf)
JSON.stringify({ count }); // '{"count":5}'

// Cleanup
count.dispose();  // removes all subscribers
```

## Options

None - `Box<T>` is intentionally zero-config. Equality check uses `Object.is`.

## Use cases

- Shared abort flag across multiple async callbacks
- Counter or toggle shared between event handlers
- Reactive state cell in a pipeline (subscribe + transform)
- Agent loop state passed into tool closures
- Test helpers that need to inspect internal counter values

## Status

Quarantine - standalone, no deps, ready to wire into any consumer.
