# sorted-set

**Status:** quarantine
**Package:** `packages/tools/sorted-set.ts`
**Export:** `SortedSet<T>`

## What it does

A set that maintains sorted order on every insert and delete. Backed by a sorted array with binary search, so membership tests, range queries, and index-based access are all O(log n) or O(1).

## API

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `(value: T) => boolean` | Insert value. Returns true if added, false if already present. |
| `delete` | `(value: T) => boolean` | Remove value. Returns true if it existed. |
| `has` | `(value: T) => boolean` | O(log n) membership test. |
| `min` | `() => T \| undefined` | Smallest element. |
| `max` | `() => T \| undefined` | Largest element. |
| `range` | `(from: T, to: T) => T[]` | All elements where `from <= e <= to` (inclusive). |
| `nth` | `(index: number) => T \| undefined` | Element at sorted index (0-based). |
| `indexOf` | `(value: T) => number` | Sorted index of value, or -1 if absent. |
| `size` | `number` (getter) | Current count. |
| `toArray` | `() => T[]` | Sorted copy of all elements. |
| `[Symbol.iterator]` | `() => Iterator<T>` | Iterate in sorted order. |

Constructor accepts an optional `Comparator<T>` and optional initial `Iterable<T>`.

## Example

```ts
import { SortedSet } from "./packages/tools/sorted-set.ts";

const s = new SortedSet<number>();
s.add(5);
s.add(2);
s.add(8);
s.add(2); // no-op, already present

console.log(s.toArray());   // [2, 5, 8]
console.log(s.min());       // 2
console.log(s.max());       // 8
console.log(s.range(3, 9)); // [5, 8]
console.log(s.nth(1));      // 5
console.log(s.indexOf(8));  // 2

// Custom comparator - descending
const desc = new SortedSet<number>((a, b) => b - a, [10, 3, 7]);
console.log(desc.toArray()); // [10, 7, 3]
```

## Complexity

| Operation | Time |
|-----------|------|
| `has` | O(log n) |
| `add` / `delete` | O(n) - array shift |
| `min` / `max` | O(1) |
| `range` | O(log n + k) where k = result size |
| `nth` / `indexOf` | O(log n) |

Suitable for sets up to ~10k elements. For larger sets, consider a balanced BST or skip list.

## Why quarantine?

New utility with no existing callers. Needs review before wiring into index.ts.
