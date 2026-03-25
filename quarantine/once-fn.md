# once-fn

## Description

Single-execution and memoization wrappers for caching expensive function results. Provides `once` for one-shot execution, `memoize` for argument-keyed caching, `memoizeAsync` for async deduplication, and `memoizeWithTTL` for time-bounded caching.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `once` | `(fn: T) => (...args) => ReturnType<T>` | Execute fn exactly once, return cached result on all subsequent calls |
| `memoize` | `(fn: T) => Memoized<T>` | Cache results keyed by JSON-serialized arguments |
| `memoizeAsync` | `(fn: T) => MemoizedAsync<T>` | Cache resolved promise values, deduplicate concurrent in-flight calls |
| `memoizeWithTTL` | `(fn: T, ttlMs: number) => MemoizedTTL<T>` | Cache results that expire after a given millisecond window |
| `clearMemo` | `(memoized) => void` | Evict all cached entries from a memoized function |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/memory/` consolidation to avoid re-computing embedding vectors for unchanged memory entries.
3. Use in `packages/providers/` to cache model capability lookups that are fetched per-request today.
4. Use in `packages/self-autonomy/reflection.ts` to ensure one-time reflection runs per session boundary.

## Source

`packages/tools/once-fn.ts` - 140 lines, zero dependencies, pure TypeScript.
