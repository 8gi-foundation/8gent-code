# prompt-cache

## Tool Name

`prompt-cache`

## Description

Caches prompt-response pairs with TTL expiry, similarity-based cache hits (Dice coefficient over bigrams), and LRU eviction. Reduces redundant API calls when the same or near-identical prompts are sent repeatedly within a session or across short time windows.

## Status

**quarantine** - implemented, not wired into the agent loop yet.

## Integration Path

1. Import `PromptCache` from `packages/tools/prompt-cache.ts`.
2. Instantiate once at agent startup (singleton per session or per provider).
3. Before every LLM call: call `cache.get(prompt)`. If non-null, return the cached response immediately.
4. After every LLM response: call `cache.set(prompt, response, tokenCount)`.
5. Expose `cache.stats()` in the debugger or activity monitor for observability.

## Key Parameters

| Option | Default | Notes |
|--------|---------|-------|
| `capacity` | 200 | LRU evicts oldest-accessed entry when full |
| `ttlMs` | 1800000 (30 min) | Entries expire after this window |
| `similarityThreshold` | 0.92 | Dice coefficient minimum for a fuzzy hit |

## Notes

- Similarity scan is O(n) at <=200 entries. For larger caches, replace with an ANN index.
- No persistence by default. Serialize entries to `.8gent/prompt-cache.json` on shutdown to persist across sessions.
- `tokens` field on `CacheEntry` enables future token-budget accounting via `packages/tools/token-estimator.ts`.
- Set `similarityThreshold: 1` to disable fuzzy matching and use exact-only lookups.
