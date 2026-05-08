# Quarantine: model-speed benchmark

**Status:** quarantine - needs review before wiring into harness
**File:** `benchmarks/categories/abilities/model-speed.ts`
**Export:** `benchmarkModel(model: string, runs?: number): Promise<ModelResult>`

---

## What it does

Measures raw model speed across two dimensions:

- **TTFT** - time to first token (latency from send to first byte of response)
- **Total time** - wall-clock time for full generation to complete
- **Tokens per second** - output throughput

Tests run against five prompts of increasing complexity (trivial, short, medium, paragraph, reasoning). Stats include median and p95 for both TTFT and total time, plus a fail rate.

---

## Prompts tested

| ID | Description | Target output |
|----|-------------|---------------|
| trivial | Single-word reply | 1 token |
| short | Single number reply | 2 tokens |
| medium | Comma-separated list | ~12 tokens |
| paragraph | 3-5 sentence explanation | ~60 tokens |
| reasoning | Math word problem with working | ~120 tokens |

---

## Usage

```bash
# Single model (default: qwen3:1.7b)
bun run benchmarks/categories/abilities/model-speed.ts

# Compare multiple models
BENCH_MODELS="qwen3:1.7b,llama3.2:3b" bun run benchmarks/categories/abilities/model-speed.ts

# Run 3 times per prompt for more stable stats
BENCH_RUNS=3 bun run benchmarks/categories/abilities/model-speed.ts

# Custom endpoint
OLLAMA_URL=http://192.168.1.5:11434 bun run benchmarks/categories/abilities/model-speed.ts
```

---

## Programmatic

```typescript
import { benchmarkModel } from "./benchmarks/categories/abilities/model-speed.ts";

const result = await benchmarkModel("qwen3:1.7b", 3);
console.log(result.stats.medianTtftMs);   // TTFT median in ms
console.log(result.stats.medianTokPerSec); // throughput
```

---

## Output format

Results saved to `benchmarks/autoresearch/model-speed-{timestamp}.json`:

```json
{
  "date": "...",
  "endpoint": "http://localhost:11434",
  "results": [
    {
      "model": "qwen3:1.7b",
      "runs": [...],
      "stats": {
        "medianTtftMs": 142,
        "p95TtftMs": 210,
        "medianTotalMs": 890,
        "p95TotalMs": 1400,
        "medianTokPerSec": 34.5,
        "failRate": 0
      }
    }
  ]
}
```

---

## Dependencies

Zero external deps. Uses `fetch` + native streaming. Requires Ollama running locally (or set `OLLAMA_URL`).

---

## Review checklist

- [ ] Confirm prompt set covers harness requirements
- [ ] Wire into harness once approved
- [ ] Consider adding OpenRouter backend alongside Ollama
- [ ] Consider warmup run to exclude cold-start outliers
