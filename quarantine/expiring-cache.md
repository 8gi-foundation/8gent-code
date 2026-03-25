# Quarantine: expiring-cache

**Package:** `packages/tools/expiring-cache.ts`
**Status:** Quarantine - needs review before promotion

## What it does

`ExpiringCache<K, V>` is a typed, in-memory cache with per-entry TTL expiry and an async factory pattern for cache-aside loading.

## API

| Method | Description |
|--------|-------------|
| `get(key)` | Return value or `undefined` if missing/expired |
| `set(key, value, ttl?)` | Store with optional per-entry TTL (ms) |
| `getOrRefresh(key, factory, ttl?)` | Return cached or call async factory and store result |
| `delete(key)` | Remove entry, returns `true` if it was fresh |
| `has(key)` | Check existence without expiry side-effects leaking |
| `size` | Count of all stored entries (including stale, pre-prune) |
| `clear()` | Wipe all entries |
| `prune()` | Evict expired entries, returns count removed |
| `destroy()` | Stop background cleanup timer |

## Constructor options

```ts
new ExpiringCache<string, Data>({
  defaultTtl: 60_000,        // 60s default TTL
  cleanupInterval: 300_000,  // prune every 5 min
})
```

- `defaultTtl` - TTL in ms applied when `set()` is called without explicit TTL. `0` = no expiry.
- `cleanupInterval` - if set, starts a background `setInterval` that calls `prune()`. The timer is unref'd so it won't block process exit.

## Usage example

```ts
import { ExpiringCache } from "./packages/tools/expiring-cache";

const cache = new ExpiringCache<string, User>({ defaultTtl: 30_000 });

// Cache-aside with async factory
const user = await cache.getOrRefresh("user:42", async (id) => {
  return fetchUserFromDB(id);
});

// Manual set with custom TTL
cache.set("session:abc", sessionData, 15 * 60 * 1000); // 15 min

// Manual prune
const removed = cache.prune();
console.log(`Pruned ${removed} expired entries`);

// Cleanup background timer when done
cache.destroy();
```

## Promotion checklist

- [ ] Unit tests added in `packages/tools/__tests__/expiring-cache.test.ts`
- [ ] Reviewed for thread-safety concerns (N/A - single-threaded JS, but concurrent async factory calls could double-fetch)
- [ ] Consider dedup in-flight requests in `getOrRefresh` if needed
- [ ] Wire into agent tool registry if used by agent tasks
