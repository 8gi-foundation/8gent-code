# linked-list

## Tool Name

`LinkedList<T>` - Doubly Linked List

## Description

Generic doubly linked list with O(1) insert/remove by node reference. Supports the full standard collection interface:

- `push(value)` - append to tail, O(1)
- `pop()` - remove from tail, O(1)
- `unshift(value)` - prepend to head, O(1)
- `shift()` - remove from head, O(1)
- `removeNode(node)` - remove by direct node reference, O(1)
- `insertAfter(ref, value)` - insert after a known node, O(1)
- `insertAt(index, value)` - insert at zero-based index, O(n) traversal
- `find(predicate)` - first match by predicate, O(n)
- `nodeAt(index)` - node at index, O(n)
- `at(index)` - value at index, O(n)
- `toArray()` - snapshot to array, O(n)
- `clear()` - reset list, O(1)
- `[Symbol.iterator]` - native for-of support

## Status

**quarantine** - self-contained, no external dependencies, not yet wired into any agent tool registry.

## Integration Path

1. Register in `packages/tools/index.ts` (or equivalent tool registry entry point).
2. Expose as an agent tool via `packages/eight/tools.ts` if linked-list operations are needed inside agent reasoning (e.g. LRU cache, ordered task queues, undo stacks).
3. Use directly in memory or orchestration packages where ordered O(1) manipulation of node chains is needed (e.g. `packages/memory/queue.ts` lease queue, `packages/orchestration/worktree-pool.ts` active pool).

## Files

- `packages/tools/linked-list.ts` - implementation (~145 lines)
