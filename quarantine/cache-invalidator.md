# cache-invalidator

## Tool Name
`CacheInvalidator` (packages/tools/cache-invalidator.ts)

## Description
Tag-based in-memory cache with dependency chain invalidation. Entries can carry multiple string tags; invalidating a tag removes all matching entries. Dependency chains allow declaring that invalidating key A automatically invalidates key B (and transitively any keys that depend on B). Supports glob/regex pattern invalidation, per-entry TTL with lazy eviction, and emits `"invalidated"` events for observability.

## Status
**quarantine** - self-contained, not yet wired into the agent or TUI.

## Integration Path
1. Import into `packages/eight/tools.ts` and register as an agent-accessible tool so Eight can cache expensive tool results (e.g. browser fetches, AST lookups) and invalidate them by tag when the underlying data changes.
2. Use in `packages/memory/store.ts` to front-cache frequent FTS5 queries; invalidate the `"memory"` tag on any write operation.
3. Expose a `/cache` command in the TUI to list cached keys, flush by tag, or purge expired entries.
4. Hook `"invalidated"` events into the debugger observability stream for real-time cache visibility.

## API Summary

```ts
const cache = new CacheInvalidator<string>();

// Store with tags, TTL, and dependency chain
cache.set("user:42:profile", data, {
  tags: ["user", "user:42"],
  ttlMs: 60_000,
  dependencies: ["user:42:permissions"],
});

cache.get("user:42:profile");           // T | undefined (TTL checked)
cache.has("user:42:profile");           // boolean

cache.invalidate("user:42:profile");    // remove one key, cascade dependents
cache.invalidateByTag("user:42");       // remove all entries tagged "user:42"
cache.invalidateByPattern("user:42:*"); // glob - remove all user:42 sub-keys
cache.purgeExpired();                   // sweep TTL-expired entries
cache.flush();                          // clear everything

cache.on("invalidated", (event) => {
  // { key, reason: "tag"|"pattern"|"dependency"|"ttl"|"manual", triggeredBy? }
});
```
