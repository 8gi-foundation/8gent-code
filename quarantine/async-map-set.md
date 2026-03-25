# async-map-set

**Status:** Quarantined - awaiting integration review
**File:** `packages/tools/async-map-set.ts`
**Lines:** ~145

## What it does

Map and Set with async iteration and operations. Provides `AsyncMap` and `AsyncSet`
for use in agent tool runners, memory stores, and orchestration pipelines where
values are derived from async factories or filtered by async predicates.

All parallel operations use `Promise.all` internally - no sequential blocking.

## API

### AsyncMap<K, V>

| Method | Description |
|--------|-------------|
| `getOrCreate(key, asyncFactory)` | Return existing value or call factory to create and store it. |
| `mapValues(asyncFn)` | Return new `AsyncMap` with every value replaced by the async transform result. |
| `filterEntries(asyncPred)` | Return new `AsyncMap` with only entries where predicate resolves true. |
| `get / set / has / delete / clear` | Standard synchronous Map operations. |
| `keys() / values() / entries()` | Standard iterators. |

### AsyncSet<T>

| Method | Description |
|--------|-------------|
| `addAsync(asyncItem)` | Resolve a Promise and add the result to the set. |
| `filterAsync(asyncPred)` | Return new `AsyncSet` with only values where predicate resolves true. |
| `add / has / delete / clear` | Standard synchronous Set operations. |
| `values()` | Standard iterator. |

## Usage example

```ts
import { AsyncMap, AsyncSet } from "./async-map-set";

// AsyncMap - cache expensive async lookups
const cache = new AsyncMap<string, string>();
const embedding = await cache.getOrCreate("hello", async (key) => {
  return await fetchEmbedding(key);
});

// mapValues - transform all values in parallel
const scores = new AsyncMap([["a", "some text"], ["b", "other"]]);
const embeddings = await scores.mapValues(async (text) => fetchEmbedding(text));

// filterEntries - keep only entries that pass an async check
const live = await cache.filterEntries(async (val, key) => isAlive(key));

// AsyncSet - resolve and collect async items
const tags = new AsyncSet<string>();
await tags.addAsync(fetchPrimaryTag(doc));

// filterAsync - remove stale entries
const valid = await tags.filterAsync(async (tag) => tagExists(tag));
```

## Key features

- **Parallel by default** - `mapValues` and `filterEntries` run all async ops concurrently via `Promise.all`.
- **Factory caching** - `getOrCreate` stores the result so subsequent sync `get()` calls hit the cache.
- **Chainable addAsync** - returns `this` after the await for optional chaining.
- No external dependencies.

## Integration notes

- Drop `AsyncMap` into `packages/memory/store.ts` as a transient cache layer for embedding lookups.
- Use `filterEntries` in `packages/orchestration/` to prune stale worktree entries.
- Use `AsyncSet` in `packages/permissions/policy-engine.ts` to collect async-resolved capability sets.
- Pairs with `parallel-map.ts` for array-level parallel operations.

## Promotion criteria

- [ ] Integrate into `packages/memory/store.ts` embedding cache
- [ ] Add to `packages/tools/index.ts` exports
- [ ] Add test file `packages/tools/async-map-set.test.ts`
