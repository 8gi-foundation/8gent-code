# compact-json

**Status:** quarantine

## Description

Compact JSON serializer that minimizes token usage when passing structured data to LLM prompts or storing agent memory snapshots.

Key behaviours:
- Strips `null` and `undefined` values by default
- Omits keys whose value matches a caller-supplied defaults map
- Deduplicates repeated strings above a configurable length threshold using `$ref` pointers (`$r` table + `$i` index)
- Enforces a configurable depth limit (default 6); deeper nodes are replaced with `"..."`
- Estimates token savings via a 4-chars-per-token heuristic

Exports:
- `compactJSON(obj, options?)` - returns a compact JSON string
- `estimateTokens(obj, options?)` - returns `{ original, compact, saved, ratio }`

## Integration path

1. **Agent context injection** (`packages/eight/prompts/system-prompt.ts`) - serialize memory snapshots and tool results through `compactJSON` before appending to the prompt.
2. **Memory store** (`packages/memory/store.ts`) - compress episodic memory blobs on write, decompress on read (store original schema alongside compact form).
3. **Tool result pipeline** (`packages/eight/tools.ts`) - wrap tool return values with `compactJSON` when the estimated token count exceeds a threshold (e.g., >200 tokens).
4. **Benchmark harness** (`benchmarks/autoresearch/`) - log token savings per run to track compression efficiency over time.

## Promotion criteria

- [ ] Round-trip test: `JSON.parse(compactJSON(obj))` recovers all non-null data
- [ ] Token savings > 15% on representative agent memory snapshots
- [ ] No breaking change to existing tool result contracts
- [ ] Integrated into at least one of the above paths with a measurable benchmark delta
