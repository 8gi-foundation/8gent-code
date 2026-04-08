# Quarantine: multi-key-map

**File:** `packages/tools/multi-key-map.ts`
**Status:** quarantine - awaiting promotion review

## What it is

`MultiKeyMap<V>` is a generic map that indexes values by a tuple of one or more
keys rather than a single key. Composite keys are serialized with `JSON.stringify`
so any JSON-serializable value (string, number, boolean, array, plain object) can
be a key component.

## API

| Method | Signature | Description |
|--------|-----------|-------------|
| `set` | `set(value: V, ...keys): this` | Store a value under the composite key |
| `get` | `get(...keys): V \| undefined` | Retrieve by composite key |
| `has` | `has(...keys): boolean` | Test existence |
| `delete` | `delete(...keys): boolean` | Remove entry, returns true if found |
| `entries` | `entries(): IterableIterator<[unknown[], V]>` | All [keyTuple, value] pairs |
| `keys` | `keys(): IterableIterator<unknown[]>` | All key tuples |
| `values` | `values(): IterableIterator<V>` | All values |
| `forEach` | `forEach(cb): void` | Iterate with callback |
| `clear` | `clear(): void` | Remove all entries |
| `size` | `readonly number` | Entry count |

## Example

```ts
import { MultiKeyMap } from "../packages/tools/multi-key-map.ts";

const cache = new MultiKeyMap<string>();

cache.set("hola",    "es", "greeting");
cache.set("hello",   "en", "greeting");
cache.set("goodbye", "en", "farewell");

cache.get("en", "greeting"); // "hello"
cache.has("es", "greeting"); // true
cache.size;                  // 3

for (const [keys, value] of cache) {
  console.log(keys, "->", value);
}
```

## Design notes

- **Serialization:** `JSON.stringify(keysArray)` - deterministic for the same
  argument order. Key order is significant: `get("a", "b")` != `get("b", "a")`.
- **No external dependencies.** Pure TypeScript, no runtime additions.
- **Composable.** Implements `Symbol.iterator` and `forEach` for compatibility
  with spread, destructuring, and for-of loops.
- **Blast radius:** one new file, zero changes to existing code.

## Promotion criteria

- [ ] Used in at least one real feature (e.g. multi-dimensional cache, tool
      routing table, permission matrix)
- [ ] Unit tests added alongside the consuming feature
- [ ] Reviewed for key-collision edge cases (object key ordering)
