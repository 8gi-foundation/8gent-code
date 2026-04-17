# cache-map

**Status:** Quarantine - pending review
**File:** `packages/tools/cache-map.ts`
**Export:** `CacheMap<K, V>`

## What it does

A drop-in Map replacement with automatic entry expiry (TTL) and max-size enforcement via LRU eviction.

## API

```ts
import { CacheMap } from './packages/tools/cache-map.ts';

const cache = new CacheMap<string, string>({
  defaultTtl: 60_000, // 1 minute
  maxSize: 500,
});

// Standard Map API
cache.set('key', 'value');
cache.get('key');        // 'value', resets lastAccessed
cache.has('key');        // true (false if expired)
cache.delete('key');
cache.size;

// Cache-aside pattern
const result = await cache.getOrSet('key', () => fetchFromDb('key'));

// Refresh TTL without changing value
cache.touch('key');
cache.touch('key', 30_000); // custom TTL override

// Manual sweep of expired entries
const removed = cache.prune();

// Observability
cache.stats();
// { size, maxSize, hits, misses, evictions, expired }
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultTtl` | `number` | `undefined` | Per-entry TTL in ms. Omit for no expiry. |
| `maxSize` | `number` | `undefined` | Max entries before LRU eviction. Omit for unbounded. |

## TTL per set call

Override default TTL for a single entry:

```ts
cache.set('short-lived', value, 5_000);   // 5s TTL for this key only
cache.set('forever', value, undefined);    // no expiry for this key
```

## Notes

- Expired entries are lazily removed on `get`/`has` - no background timer.
- Call `prune()` periodically if unbounded growth of stale keys is a concern.
- `getOrSet` is async-safe - awaits the factory before inserting.
- Iteration (`keys()`, `values()`, `for...of`) silently skips expired entries.
- LRU eviction is O(n) scan - suitable for maxSize up to a few thousand.
