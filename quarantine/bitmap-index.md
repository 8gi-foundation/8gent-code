# Quarantine: bitmap-index

## What

Bitmap index for fast set operations on categorical agent data. Uses 32-bit integer arrays as backing storage - each bit position maps to an item ID. Supports intersection (AND), union (OR), complement (NOT), symmetric difference (XOR), popcount, and iteration over set positions. Zero external dependencies.

## Status

**quarantine** - new file, untested in CI, not wired into tool registry.

## File

`packages/tools/bitmap-index.ts` (~140 lines)

## API

```ts
import { BitmapIndex } from './packages/tools/bitmap-index.ts';

// Build from array of IDs
const tags = BitmapIndex.fromArray([0, 3, 7, 15], 32);

// Manual set/unset
const idx = new BitmapIndex(64);
idx.set(5).set(12).set(42);

// Membership test
idx.has(5);   // true
idx.has(6);   // false

// Set operations - all return new BitmapIndex
const both     = a.and(b);   // intersection
const either   = a.or(b);    // union
const diff     = a.xor(b);   // symmetric difference
const flip     = a.not();    // complement within capacity

// Cardinality
tags.count();       // 4

// Iterate set positions
for (const pos of tags.positions()) console.log(pos);
// 0, 3, 7, 15

// Snapshot to array
tags.toArray();  // [0, 3, 7, 15]
```

## Integration path

- [ ] Add unit tests covering all operations and edge cases (empty, full, single-bit)
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Expose as agent-callable tool in `packages/eight/tools.ts` for filtering memory/tool results by category sets
- [ ] Benchmark AND/OR throughput at 10k, 100k, 1M capacity vs naive array filter
- [ ] Consider roaring bitmap upgrade if capacity > 1M becomes a real need
