# slot-map

**Tool name:** `SlotMap<T>`
**File:** `packages/tools/slot-map.ts`
**Status:** quarantine

## Description

Generational index slot map providing stable entity references with automatic dangling-reference detection.

Each inserted value gets a `Handle` (a `bigint` encoding a slot index and a generation counter). When a slot is removed and later reused, the generation increments - any stale copy of the old handle is detected immediately by comparing generations, returning `undefined` instead of silently aliasing unrelated data.

### API surface

| Method | Description |
|--------|-------------|
| `insert(value): Handle` | Add a value, return a stable handle |
| `get(handle): T \| undefined` | Retrieve by handle; undefined if stale |
| `has(handle): boolean` | Check liveness without fetching value |
| `remove(handle): T \| undefined` | Remove and invalidate all copies of handle |
| `entries(): Iterable<[Handle, T]>` | Iterate live [handle, value] pairs |
| `values(): Iterable<T>` | Iterate live values |
| `compact(): number` | Reclaim dead slot memory; returns slots freed |
| `size: number` | Count of live entries |

### Properties

- O(1) insert, get, remove
- No external dependencies
- Self-contained - 150 lines, zero imports
- Compact is O(n) and invalidates handles - document call sites clearly

## Integration path

1. **Entity pools** - agent worktrees, sub-agent handles, tool instances that get created and destroyed during a session
2. **Memory layer** - stable references to episodic memory records across consolidation passes
3. **Orchestration** - `WorktreePool` could replace its numeric IDs with `Handle` values to prevent ID reuse bugs
4. **Event system** - listener registrations that can be removed without leaving stale callbacks

To promote out of quarantine: add at least one consumer in `packages/` with a passing test, then remove this file and update the consumer's own docs.
