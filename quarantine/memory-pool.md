# memory-pool

## Tool Name

`ObjectPool<T>` - generic object pool allocator

## Description

Pre-allocates typed objects at construction time and reuses them via an
acquire/release pattern. Eliminates repeated heap allocation and GC churn in
performance-critical hot paths: agent loop, tool dispatch, streaming pipelines.

Key properties:
- Pre-allocation at init, configurable initial size (default 16)
- Auto-grow when exhausted, configurable increments (default 8)
- Optional hard cap via `maxSize` to bound memory usage
- Optional `reset` callback called on `release()` to sanitize objects
- `use(fn)` helper for scoped acquire + auto-release
- `stats()` for observability: capacity, in-use, miss rate, grow count

## Status

**quarantine** - standalone, zero dependencies, no side effects. Not wired
into any package yet. Safe to evaluate in isolation.

## Integration Path

1. `packages/eight/agent.ts` - pool tool-call scratch objects per iteration
2. `packages/eight/streaming.ts` - pool token buffer objects reused across chunks
3. `packages/orchestration/` - pool WorktreeTask instances for WorktreePool
4. `packages/memory/store.ts` - pool query result containers for FTS5 hot paths

## Files

| File | Role |
|------|------|
| `packages/tools/memory-pool.ts` | Implementation |
| `quarantine/memory-pool.md` | This spec |
