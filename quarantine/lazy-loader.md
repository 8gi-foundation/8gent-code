# lazy-loader

## Tool Name
`lazy-loader`

## Description
Lazy initialization with memoization for expensive computations. Provides a `Lazy<T>` container that computes a value on first access and caches it for all subsequent reads. Supports synchronous and asynchronous factories, manual reset to clear the cache, and a `lazyRecord` helper for objects where each property is initialized independently on demand. Cache hit/miss statistics are tracked per instance.

## Status
`quarantine`

Implemented and self-contained. No external dependencies. Pending integration review and usage in the agent runtime.

## Exports
- `lazy<T>(factory: () => T): Lazy<T>` - sync lazy value
- `asyncLazy<T>(factory: () => Promise<T>): AsyncLazy<T>` - async lazy value with in-flight deduplication
- `lazyRecord<T>(factories): LazyRecord<T>` - object with per-key lazy initialization

## Integration Path
1. **Agent tool initialization** - wrap expensive tool setup (browser, DB connections) with `asyncLazy` so the cost is deferred until the tool is actually used in a session.
2. **Config loading** - use `lazy` for parsed config objects read from disk.
3. **Package index** - replace ad-hoc `let instance: X | undefined` patterns in `packages/eight/agent.ts` and provider files with typed `Lazy<T>` containers.
4. **Memory store** - wrap `MemoryStore` initialization in `asyncLazy` to avoid paying the SQLite open cost on sessions that never query memory.

## File
`packages/tools/lazy-loader.ts`
