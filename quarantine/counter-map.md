# counter-map

## Tool Name
`counter-map`

## Description
Python-style `Counter<T>` for frequency counting any key type.
Generic, zero-dependency, works with strings, numbers, or any object type.

- `increment(key, n?)` - add n to key (default 1), creates if absent
- `decrement(key, n?)` - subtract n, removes key at/below zero
- `get(key)` - count for key, 0 if absent
- `mostCommon(n?)` - top n keys by count, descending
- `leastCommon(n?)` - bottom n keys by count, ascending
- `total()` - sum of all counts
- `entries()` - all `[key, count]` pairs sorted descending
- `merge(other)` - add counts from another Counter in-place
- `subtract(other)` - subtract counts from another Counter in-place
- `clone()` - copy of the Counter
- `toObject()` - plain object snapshot (string keys only)

## Status
**quarantine** - self-contained, no external deps, not yet wired into any pipeline.

## Integration Path
1. Import from `packages/tools/counter-map.ts`
2. Use in `packages/memory/` to track term frequencies for FTS5 weighting
3. Use in `benchmarks/autoresearch/harness.ts` to track tool-call frequencies per loop
4. Use in `packages/self-autonomy/reflection.ts` to count skill outcomes by category
5. Graduate from quarantine once used in at least one pipeline with measurable output
