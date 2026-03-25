# Quarantine: multimap

## Tool Name
`MultiMap<K, V>`

## Description
A typed map that allows multiple values per key. Wraps `Map<K, V[]>` with a clean API for:
- `put(key, value)` - add a value under a key (duplicates allowed)
- `get(key)` - first value for a key
- `getAll(key)` - all values for a key
- `remove(key, value)` - remove first occurrence of a specific key-value pair
- `removeAll(key)` - remove all values under a key
- `has(key, value)` - check if exact key-value pair exists
- `hasKey(key)` - check if key exists at all
- `keys()` / `values()` / `entries()` / `keyEntries()` iterators
- `size` (total values) and `keyCount` (distinct keys)
- `clear()`

## Status
**quarantine** - implemented, not yet wired into the agent or any package.

## Location
`packages/tools/multimap.ts`

## Integration Path
1. Import into `packages/tools/index.ts` when ready to expose as a core tool.
2. Candidate use cases: tag indexes, multi-label classification results, dependency graphs with multiple edges, grouping memory entries by topic.
3. No external dependencies - pure TypeScript, Bun-compatible.
4. Add unit tests in `packages/tools/__tests__/multimap.test.ts` before promoting out of quarantine.
