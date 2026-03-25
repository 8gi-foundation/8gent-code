# quarantine: group-by

**Status:** quarantine - review before wiring into agent loop

## What it does

Five pure array-grouping utilities with no external dependencies. Handles
the most common "group this list by that field" patterns agents encounter
when processing tool output, memory results, or structured data.

## API

```ts
import {
  groupBy,
  groupByMultiple,
  countBy,
  indexBy,
  partition,
} from "../packages/tools/group-by.ts";

// Group items into buckets
groupBy(files, f => f.extension);
// { ts: [...], md: [...], json: [...] }

// Nested grouping - one level per key fn
groupByMultiple(tasks, [t => t.status, t => t.priority]);
// { open: { high: [...], low: [...] }, done: { ... } }

// Count occurrences per key
countBy(events, e => e.type);
// { error: 4, info: 12, warn: 2 }

// Index by unique key (last-wins on collision)
indexBy(users, u => u.id);
// { 'abc': { id: 'abc', name: 'Alice' }, ... }

// Split into [passing, failing] tuple
const [active, inactive] = partition(sessions, s => s.active);
```

## Features

- `groupBy` - groups array into `Record<string, T[]>` by a key fn
- `groupByMultiple` - recursively groups by an ordered list of key fns
- `countBy` - returns `Record<string, number>` frequency map
- `indexBy` - returns `Record<string, T>` lookup map (last-wins on collision)
- `partition` - returns `[T[], T[]]` split by predicate
- All functions are pure - no mutation of input arrays
- Keys are always coerced to strings via `String()` for consistent access

## Constraints

- `groupByMultiple` with 0 key fns returns the array cast to the return type
- `indexBy` does not throw on duplicate keys - last item wins, document your assumption
- No aggregation beyond counting - for sum/avg, reduce the grouped buckets yourself

## Files

- `packages/tools/group-by.ts` - implementation (~130 lines)

## Not doing

- No aggregation functions (sum, avg, min, max) - composable: `Object.values(grouped).map(g => g.reduce(...))`
- No lazy/streaming grouping - operates on full arrays
- No deep-key path strings like `"user.address.city"` - pass a key fn instead
