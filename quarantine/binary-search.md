# binary-search

## Tool Name
`binary-search`

## Description
Generic binary search utilities for sorted collections. Provides O(log n) search, lower/upper bound, insertion point, range search, and key-based search for sorted object arrays. All operations accept a custom comparator for full flexibility.

**Exports:**
- `binarySearch(arr, target, cmp?)` - find index of first matching element, -1 if not found
- `lowerBound(arr, target, cmp?)` - first index >= target
- `upperBound(arr, target, cmp?)` - first index > target
- `insertionPoint(arr, target, cmp?)` - index to insert while maintaining sort order
- `rangeSearch(arr, target, cmp?)` - [start, end) range of all matching elements
- `searchByKey(arr, key, value)` - binary search in sorted object array by a specific key
- `lowerBoundByKey(arr, key, value)` - lower bound by key
- `upperBoundByKey(arr, key, value)` - upper bound by key

## Status
`quarantine` - self-contained, no external dependencies, not yet wired into any agent package.

## Integration Path
1. Import into `packages/tools/index.ts` when needed by agent or memory subsystem.
2. Useful in `packages/memory/store.ts` for binary searching sorted event/timestamp arrays.
3. Useful in `packages/orchestration/` for sorted task queue management.
4. Can replace any linear scans over sorted data in the codebase.
