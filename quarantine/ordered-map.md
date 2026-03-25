# ordered-map

**Status:** Quarantine - pending review before wiring into core packages.

## What it is

`OrderedMap<K, V>` - a map that preserves insertion order and exposes positional access by index.

Backed by a native `Map<K, V>` (O(1) keyed operations) plus a parallel `K[]` array for stable ordering.

## Why it exists

JavaScript's built-in `Map` preserves insertion order for iteration but gives no way to access the nth entry, find the index of a key, or slice a range without iterating the whole structure. This is a thin, dependency-free layer that adds exactly that.

## API surface

| Method | Complexity | Description |
|--------|-----------|-------------|
| `set(key, value)` | O(1) | Insert or update. Appends key if new. |
| `get(key)` | O(1) | Value lookup. |
| `has(key)` | O(1) | Key existence check. |
| `delete(key)` | O(n) | Remove entry (must splice keys array). |
| `clear()` | O(1) | Remove all entries. |
| `nth(index)` | O(1) | Entry at insertion-order index. Supports negative indices. |
| `indexOf(key)` | O(n) | Insertion-order index of a key. |
| `first()` | O(1) | First entry. |
| `last()` | O(1) | Last entry. |
| `slice(start, end)` | O(k) | New OrderedMap for a range of entries. |
| `reverse()` | O(n) | New OrderedMap with order reversed. |
| `toArray()` | O(n) | All entries as `[K, V][]`. |
| `size` | O(1) | Number of entries. |
| `[Symbol.iterator]` | - | Iterate `[K, V]` pairs in order. |
| `keys()` / `values()` / `entries()` | - | Standard iterators in insertion order. |

## File

`packages/tools/ordered-map.ts` - 140 lines, zero dependencies.

## Candidate use cases in this repo

- Ordered tool registry where position matters (e.g., priority-ordered tool list with fast key lookup)
- Session history where you need both keyed access and positional slicing
- Memory store result ordering where recency position is meaningful alongside ID lookup

## Quarantine checklist

- [ ] Unit tests added
- [ ] Edge cases verified: empty map, negative indices, duplicate set, delete-then-reinsert
- [ ] Wired into `packages/tools/index.ts`
- [ ] At least one consumer identified and validated
