# string-similarity

## Tool Name
`string-similarity`

## Description
Computes similarity scores between strings using three algorithms:

- **Jaccard index** - set overlap on character bigrams: `|A ∩ B| / |A ∪ B|`
- **Cosine similarity** - trigram frequency vectors, dot-product normalised
- **Dice coefficient** - harmonic bigram overlap: `2 * |A ∩ B| / (|A| + |B|)`

All scores are in `[0, 1]` where `1` means identical. The `bestMatch` function averages all three algorithms to pick the closest candidate from a list.

## API

```ts
import { similarity, bestMatch } from "../packages/tools/string-similarity";

similarity("hello", "helo");              // 0.67  (dice, default)
similarity("hello", "helo", "jaccard");   // 0.50
similarity("hello", "helo", "cosine");    // 0.58

bestMatch("helo", ["hello", "world", "help"]);
// { candidate: "hello", score: 0.63, index: 0 }
```

## Status
**quarantine** - self-contained, no external deps, not yet wired into the agent tool registry.

## Integration Path
1. Import and register in `packages/tools/index.ts` under the `tools` export map.
2. Add a tool definition wrapper (name, description, inputSchema, execute) following the pattern in `packages/tools/rate-limiter.ts`.
3. Wire into `packages/eight/tools.ts` so the agent can call it for fuzzy command matching, memory deduplication, or candidate ranking.
4. Add unit tests under `packages/tools/__tests__/string-similarity.test.ts`.

## Use Cases
- Fuzzy command matching in the TUI (user typos)
- Memory deduplication - detect near-duplicate episodic memories before insertion
- Candidate ranking for code symbol search suggestions
- Soft matching for file/path resolution when exact lookup fails
