# Quarantine: Deque

**Status:** quarantine
**Package:** `packages/tools/deque.ts`
**Exported:** `Deque<T>`

## What it is

A double-ended queue (deque) backed by a ring buffer. Supports O(1) amortized push and pop on both ends, with automatic capacity doubling on overflow.

## API

| Method | Description |
|--------|-------------|
| `pushFront(value)` | Add element to the front |
| `pushBack(value)` | Add element to the back |
| `popFront()` | Remove and return the front element |
| `popBack()` | Remove and return the back element |
| `peekFront()` | Read front element without removing |
| `peekBack()` | Read back element without removing |
| `size` | Number of elements (getter) |
| `isEmpty()` | True if no elements |
| `toArray()` | Snapshot as front-to-back array |
| `clear()` | Remove all elements |
| `[Symbol.iterator]()` | Iterate front to back |

## Complexity

| Operation | Time |
|-----------|------|
| pushFront / pushBack | O(1) amortized |
| popFront / popBack | O(1) |
| peekFront / peekBack | O(1) |
| toArray | O(n) |
| clear | O(1) |

## Use cases

- Sliding window algorithms
- BFS queue with front-priority fast lanes
- Undo/redo stacks with bounded history
- Task scheduler with priority injection at front

## Promotion criteria

- [ ] Unit tests covering all operations
- [ ] Edge cases: empty pop, single element, grow trigger
- [ ] Benchmarked vs naive array-based deque
- [ ] Integrated into at least one existing package (e.g. memory, orchestration)
