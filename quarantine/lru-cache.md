# Quarantine: lru-cache

**Status:** Under review
**File:** `packages/tools/lru-cache.ts`
**Export:** `LRUCache<K, V>`

## What it does

Generic LRU (Least-Recently-Used) cache with:

- Configurable max capacity (default 100 entries)
- Per-cache and per-set TTL (time-to-live) in milliseconds
- Hit/miss/eviction counters with computed `hitRate` and `missRate`
- `onEvict` callback fired on both capacity eviction and TTL expiry
- `purgeExpired()` to manually sweep stale entries
- `resetStats()` to zero counters between measurement windows
- Zero dependencies - pure TypeScript, no imports

## API

```ts
import { LRUCache } from "./packages/tools/lru-cache.ts";

const cache = new LRUCache<string, Response>({
  maxSize: 500,
  ttl: 60_000,           // 60 s default TTL
  onEvict: (key, val) => console.log("evicted", key),
});

cache.set("key", value);
cache.set("key2", value2, 5_000); // per-entry TTL override

cache.get("key");   // undefined if expired or missing
cache.has("key");
cache.delete("key");
cache.clear();
cache.purgeExpired();

cache.stats();
// { hits, misses, evictions, size, hitRate, missRate }
```

## Design notes

- Doubly-linked list + Map gives O(1) get/set/delete
- Serialises non-string keys via `JSON.stringify` - object keys must be stable
- TTL is checked lazily on `get`/`has`; `purgeExpired()` for eager sweeps
- No `setInterval` timers - no background overhead

## Quarantine checklist

- [ ] Integration test against a real use case (e.g. browser cache, memory store)
- [ ] Benchmark at 10k ops to confirm O(1) behaviour holds
- [ ] Confirm key serialisation strategy is acceptable for object keys
- [ ] Wire into `packages/tools/index.ts` export once approved
