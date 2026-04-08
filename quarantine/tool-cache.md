# Quarantine: tool-cache

**Package:** `packages/eight/tool-cache.ts`
**Status:** Quarantine - not yet wired into the agent loop
**Branch:** `quarantine/tool-cache`

---

## What it does

`ToolCache` is a zero-dependency, in-process LRU cache for deterministic tool
results. It sits between the agent loop and tool execution - before calling a
tool, check the cache; after execution, store the result.

---

## Design

### Key = SHA-256(toolName + sorted JSON args)

Args are JSON-serialised with keys sorted to ensure `{a:1, b:2}` and
`{b:2, a:1}` produce the same hash.

### TTL per category

| Category | Default TTL | Rationale |
|---|---|---|
| `deterministic` | 1 hour | Pure functions - result depends only on args |
| `read` | 30 s | Filesystem reads; short TTL to avoid stale state |
| `network` | 5 min | HTTP responses; avoid hammering external services |
| `write` | 0 (never) | Write tools mutate state - never cached |

Individual tools can override via `toolTtl` in constructor options.

### Write invalidation

When any write-category tool is called (`write_file`, `run_command`, etc.),
all `read`-category entries are immediately evicted. Deterministic and network
entries are left untouched since they do not depend on local filesystem state.

### LRU eviction

The `Map` insertion-order is used as an implicit LRU queue - LRU entry is at
the head, MRU at the tail. On a cache hit the entry is deleted and re-inserted
at the tail. When `maxEntries` is exceeded the head entry is evicted.

Default `maxEntries`: 512.

---

## Integration plan (when graduating from quarantine)

1. Import `getToolCache` in `packages/eight/agent.ts`.
2. In the tool execution dispatch loop, before calling the tool handler:
   ```ts
   const cache = getToolCache();
   const cached = cache.get(toolName, toolArgs);
   if (cached !== undefined) return cached;
   ```
3. After execution:
   ```ts
   cache.set(toolName, toolArgs, result);
   ```
4. Call `cache.purgeExpired()` at the start of each agent session to reclaim
   memory from expired entries.
5. Expose `cache.stats()` in the debugger panel.

---

## What is NOT done here

- Persistence across processes (in-memory only).
- Distributed / multi-worker cache sharing.
- Metrics export to the benchmark harness.
- Per-user cache namespacing.

Those can be layered in once the quarantine proves value.

---

## Risks

- Stale reads if the 30 s TTL is too long for fast-moving projects. Tunable
  via `options.ttl.read`.
- Hash collisions are theoretically possible with SHA-256 but practically zero.
- The cache holds live JS objects. Large tool results (e.g. big file reads)
  will increase heap pressure. Monitor with `cache.stats().size`.
