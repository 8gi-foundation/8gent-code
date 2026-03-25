# Context Window Efficiency Benchmark

**Date:** 2026-03-25
**Status:** Quarantine - needs validation against real agent sessions
**Benchmark:** `benchmarks/categories/abilities/context-efficiency.ts`

---

## What It Tests

Measures how well the agent retrieves planted information as context utilization grows from 25% to 100% of the model's context window.

### Probes

| Fill Level | Context Tokens (8K model) | What We Measure |
|------------|--------------------------|-----------------|
| 25% | ~1,740 | Baseline recall accuracy |
| 50% | ~3,480 | Mid-range degradation |
| 75% | ~5,220 | Pressure point for most local models |
| 100% | ~6,960 | Full window - accuracy cliff detection |

### Metrics

1. **Accuracy at each fill level** - can the model find a fact planted at 30% depth in code-like filler?
2. **AST-first signal detection** - does the response show signs of targeted extraction (outlines, symbols) vs brute-force reading?
3. **Latency scaling** - how does response time degrade as context grows?

---

## Why This Matters for 8gent

Context efficiency is the bottleneck for local-first agents. A model that degrades at 75% fill means the agent must be smarter about what it loads into context. This benchmark establishes:

- The accuracy cliff point for each model (where recall drops below useful)
- Whether AST-first exploration patterns actually help vs reading full files
- Baseline numbers to compare against KV cache compression improvements (see `quarantine/google-kv-cache-optimization.md`)

---

## How to Run

```bash
# Default: qwen3:1.7b with 8K context
bun run benchmarks/categories/abilities/context-efficiency.ts

# Custom model and context size
OLLAMA_MODEL=llama3:8b MODEL_CTX=16384 bun run benchmarks/categories/abilities/context-efficiency.ts
```

Results are saved as JSON to `benchmarks/autoresearch/context-efficiency-{timestamp}.json`.

---

## Graduation Criteria

Move out of quarantine when:

1. Tested against at least 3 models (1.7B, 7B, 14B)
2. Results are reproducible (< 10% variance across 3 runs)
3. AST-first detection validated against actual agent tool-call logs
4. Integrated into the autoresearch harness loop

---

## Known Limitations

- Token counting is approximate (4 chars per token heuristic)
- AST-first detection checks response text for signal words, not actual tool calls
- The planted fact position (30% depth) is fixed - should test multiple positions
- Single-turn only - does not test multi-turn context accumulation
