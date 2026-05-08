# Quarantine: async-iterator-utils

**Status:** Quarantine - awaiting review before wiring into production

**File:** `packages/tools/async-iterator-utils.ts`

---

## What it does

A standalone utility module for composing and consuming async iterables. Works
with any `AsyncIterable<T>` - generator functions, streams, event emitters,
or any object implementing the async iteration protocol.

## API

| Function | Signature | Description |
|----------|-----------|-------------|
| `mapAsync` | `(iter, fn) => AsyncIterable<U>` | Transform each value |
| `filterAsync` | `(iter, fn) => AsyncIterable<T>` | Keep values matching predicate |
| `takeAsync` | `(iter, n) => AsyncIterable<T>` | Emit first n values then stop |
| `chunkAsync` | `(iter, size) => AsyncIterable<T[]>` | Batch into fixed-size arrays |
| `mergeAsync` | `(...iters) => AsyncIterable<T>` | Concurrent merge, unordered |
| `toArrayAsync` | `(iter) => Promise<T[]>` | Collect all values into array |
| `forEachAsync` | `(iter, fn) => Promise<void>` | Side-effect for each value |
| `reduceAsync` | `(iter, fn, init) => Promise<U>` | Fold to a single value |

## Usage examples

```ts
import {
  mapAsync, filterAsync, takeAsync, chunkAsync,
  mergeAsync, toArrayAsync, forEachAsync, reduceAsync
} from "@8gent/tools/async-iterator-utils";

// Map + filter + collect
async function* numbers() { for (let i = 0; i < 10; i++) yield i; }

const evens = filterAsync(numbers(), (n) => n % 2 === 0);
const doubled = mapAsync(evens, (n) => n * 2);
const result = await toArrayAsync(doubled);
// => [0, 4, 8, 12, 16]

// Chunk a stream into batches of 3
const batches = chunkAsync(numbers(), 3);
await forEachAsync(batches, (batch) => console.log(batch));
// [0,1,2]  [3,4,5]  [6,7,8]  [9]

// Merge two concurrent sources
async function* slow() { /* yields over time */ }
async function* fast() { /* yields faster */ }
const merged = mergeAsync(slow(), fast()); // interleaved, first-come order

// Sum via reduce
const sum = await reduceAsync(numbers(), (acc, n) => acc + n, 0);
// => 45
```

## Design notes

- All generator functions use `async function*` - composable and lazy.
- `mergeAsync` runs all sources concurrently via a shared queue and a
  promise-based notify pattern. No external dependencies.
- `takeAsync` returns early via `return` inside `for await`, cleanly
  signalling to the upstream generator that iteration is done.
- Zero dependencies beyond TypeScript and the JS runtime.

## Quarantine checklist

- [ ] Unit tests added (`packages/tools/async-iterator-utils.test.ts`)
- [ ] Wired into `packages/tools/index.ts` exports
- [ ] Reviewed for edge cases: empty iterables, errors mid-stream, size=0 on chunk
- [ ] `mergeAsync` stress-tested with high-throughput sources
