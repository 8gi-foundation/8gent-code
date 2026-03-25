# sorted-array

**Tool:** `SortedArray<T>`
**File:** `packages/tools/sorted-array.ts`
**Status:** quarantine

## Description

A generic sorted array that maintains sort order on every insert using binary search.
Supports custom comparators, O(1) min/max, O(log n) insert and indexOf, range queries,
and O(m+n) sorted merge of two instances.

## API

| Method | Complexity | Notes |
|--------|-----------|-------|
| `insert(value)` | O(log n) search + O(n) splice | Returns `this` for chaining |
| `indexOf(value)` | O(log n) | Returns -1 if not found |
| `remove(value)` | O(log n + n) | Removes first occurrence |
| `removeAll(value)` | O(k * (log n + n)) | Removes all occurrences |
| `range(low, high)` | O(log n + k) | Inclusive bounds |
| `min()` | O(1) | First element |
| `max()` | O(1) | Last element |
| `SortedArray.merge(a, b)` | O(m + n) | Returns new SortedArray |

## Usage

```ts
import { SortedArray } from './packages/tools/sorted-array.ts';

// Numbers (default comparator)
const arr = new SortedArray<number>();
arr.insert(5).insert(2).insert(8).insert(1);
arr.toArray(); // [1, 2, 5, 8]
arr.min();     // 1
arr.max();     // 8
arr.range(2, 6); // [2, 5]

// Custom comparator (objects by field)
const byAge = new SortedArray<{ name: string; age: number }>(
  (a, b) => a.age - b.age
);
byAge.insert({ name: 'Alice', age: 30 });
byAge.insert({ name: 'Bob', age: 25 });
byAge.min(); // { name: 'Bob', age: 25 }

// Merge
const a = new SortedArray<number>(undefined, [1, 3, 5]);
const b = new SortedArray<number>(undefined, [2, 4, 6]);
SortedArray.merge(a, b).toArray(); // [1, 2, 3, 4, 5, 6]
```

## Integration Path

1. Wire into `packages/eight/tools.ts` as a utility available to agent tool-calls.
2. Use in memory consolidation (`packages/memory/`) for sorted event/time indexes.
3. Use in task queue (`packages/tools/task-queue.ts`) for priority-sorted job ordering.

## Notes

- Self-contained, zero dependencies, 150 lines.
- Splice insert is O(n) due to array shift - acceptable for lists under ~10k elements.
  For larger datasets, consider a skip list or B-tree.
- `merge()` bypasses insert loop for O(m+n) rather than O((m+n) log(m+n)).
