# compact-set

**Status:** Quarantined - pending review
**File:** `packages/tools/compact-set.ts`
**Size:** ~140 lines

## What it is

`CompactSet` is a memory-efficient set for small integer domains backed by a `Uint32Array` bit array. One bit per integer - no object overhead.

## Why it exists

Native `Set<number>` carries significant per-entry overhead (~50-100 bytes per entry in V8). For dense integer domains (e.g., tracking visited node IDs 0-1023), a bit array is orders of magnitude cheaper.

- capacity=1024 -> 128 bytes (vs ~50KB for a native Set)
- capacity=65536 -> 8KB (vs ~3MB for a native Set)

## API

```ts
const s = new CompactSet(1024);

s.add(5);        // true (newly added)
s.has(5);        // true
s.delete(5);     // true (was present)
s.size;          // 0
s.toArray();     // sorted array of members
s.clear();       // empties set

s.union(other);          // new set: this | other
s.intersection(other);   // new set: this & other
s.difference(other);     // new set: this & ~other

for (const v of s) { ... }  // iterable
```

## Constraints

- Integer domain only: values must be integers in `[0, capacity)`.
- `capacity` is fixed at construction. Not auto-resizing.
- Values outside range throw `RangeError` on `add()`. `has()` and `delete()` return false for out-of-range values.

## Use cases in 8gent

- Tracking visited AST node IDs in `packages/ast-index/`
- Seen memory entry IDs during consolidation in `packages/memory/`
- Tool execution deduplication within a session (tool call ID sets)
- Permission bit masks for `packages/permissions/`

## Promotion criteria

- [ ] At least one real use site wired in (not just unit tests)
- [ ] Benchmark showing measurable memory or perf improvement vs native Set
- [ ] Edge cases covered: empty set, single element, full capacity
