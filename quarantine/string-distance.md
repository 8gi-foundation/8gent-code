# string-distance

**Tool name:** string-distance
**File:** `packages/tools/string-distance.ts`
**Status:** quarantine

## Description

Self-contained string distance library implementing three algorithms plus a unified normalized scoring interface.

| Export | Algorithm | Notes |
|--------|-----------|-------|
| `hamming(a, b)` | Hamming | Equal-length strings only. Counts differing positions. |
| `damerauLevenshtein(a, b)` | Damerau-Levenshtein | Full edit distance with transpositions. |
| `jaroWinkler(a, b)` | Jaro-Winkler | Similarity score [0,1]. Prefix-boosted. |
| `normalizedDistance(a, b, algorithm)` | All three | Returns distance in [0,1]. Default: damerau-levenshtein. |

## Integration Path

1. **Memory deduplication** - `packages/memory/store.ts` can use `normalizedDistance` to detect near-duplicate episodic memories before insertion.
2. **Tool name fuzzy matching** - `packages/eight/tools.ts` can use Jaro-Winkler to surface close tool matches when the agent misspells a tool name.
3. **Spelling correction in chat input** - TUI input layer can suggest corrections for unknown commands.
4. **Benchmark harness** - `benchmarks/autoresearch/` can compare expected vs actual output labels with normalized Damerau-Levenshtein instead of string equality.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test surface

```ts
hamming("karolin", "kathrin")           // 3
damerauLevenshtein("kitten", "sitting") // 3
jaroWinkler("MARTHA", "MARHTA")         // ~0.961
normalizedDistance("abc", "axc", "damerau-levenshtein") // 0.333
```
