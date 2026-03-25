# deep-merge

**Status:** quarantine

## Description

Deep merges N objects with configurable array and conflict strategies.

Handles:
- Recursive deep merge of plain objects
- Configurable array strategies: `replace` (default), `concat`, `unique`
- Circular reference detection via WeakSet
- Per-key custom merge functions (`customMerge` option)
- Undefined incoming values are skipped (do not overwrite existing)

## API

```ts
import { deepMerge } from "../packages/tools/deep-merge.ts";

// Basic merge
deepMerge({ a: 1 }, { b: 2 });
// => { a: 1, b: 2 }

// Array concat
deepMerge({ tags: ["a"] }, { tags: ["b"] }, { arrayStrategy: "concat" });
// => { tags: ["a", "b"] }

// Array unique (deduplicates primitives)
deepMerge({ ids: [1, 2] }, { ids: [2, 3] }, { arrayStrategy: "unique" });
// => { ids: [1, 2, 3] }

// Custom per-key merge
deepMerge(
  { score: 10 },
  { score: 5 },
  { customMerge: { score: (a, b) => (a as number) + (b as number) } }
);
// => { score: 15 }
```

## Integration Path

1. Import into `packages/eight/tools.ts` as a registered tool if the agent needs to merge config objects at runtime.
2. Use in `packages/memory/store.ts` for merging episodic memory updates without losing existing keys.
3. Use in `packages/self-autonomy/` when merging persona mutation deltas onto the base persona object.
4. Can replace ad-hoc `Object.assign` / spread merges across the codebase once promoted from quarantine.

## Promotion Criteria

- [ ] Unit tests covering all three array strategies
- [ ] Circular reference test (no infinite loop)
- [ ] Custom merge function test
- [ ] Benchmarked against a reference (e.g., `deepmerge` npm package)
- [ ] Integrated into at least one real call site
