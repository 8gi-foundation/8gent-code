# fuzzy-match

**Tool name:** fuzzy-match
**Status:** quarantine
**Package:** `packages/tools/fuzzy-match.ts`

## Description

Fuzzy string matching using Levenshtein edit distance with scored, ranked results. No external dependencies. ~120 lines of TypeScript.

Features:
- Levenshtein distance with space-optimized two-row DP (O(min(m,n)) space)
- Normalized score (0-1) with prefix and substring bonuses
- Results sorted by score descending
- Configurable minimum score threshold, result limit, and case sensitivity

## API

```ts
import { fuzzyMatch, levenshtein, score } from "../packages/tools/fuzzy-match.ts";

fuzzyMatch("rout", ["router", "route", "root", "run"])
// => [
//   { candidate: "route",  score: 0.9, distance: 1 },
//   { candidate: "router", score: 0.8, distance: 2 },
//   { candidate: "root",   score: 0.5, distance: 2 },
// ]

fuzzyMatch("cmd", candidates, { minScore: 0.4, limit: 5 })
levenshtein("kitten", "sitting") // => 3
score("rout", "router") // => 0.8
```

## Integration Path

1. Wire into `packages/tools/index.ts` exports when promoted from quarantine.
2. Use in the TUI command palette to power fuzzy command search.
3. Use in `packages/memory/store.ts` as a fallback ranking layer on top of FTS5.
4. Use in `packages/eight/tools.ts` to add a `fuzzy_search` tool for file-finder workflows.

## Promotion Criteria

- [ ] Unit tests passing (exact match, prefix, substring, case-insensitive, limit, minScore)
- [ ] Integrated into at least one consumer (command palette or memory store)
- [ ] Benchmark: < 1ms for 10k candidates at query length 10
