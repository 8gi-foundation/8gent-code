# Quarantine: Model Quality Comparison Benchmark

## Problem

We run multiple local models (qwen3.5, eight, devstral) but have no systematic data on which model performs best for which task type. Routing decisions are based on gut feeling, not evidence.

## What this adds

`benchmarks/categories/abilities/model-quality.ts` - a standalone benchmark that:

1. Runs 4 task types (code generation, bug fixing, explanation, architecture) across all 3 local models
2. Measures per-model: response time (ms), output token count, quality score (0-100 via LLM judge)
3. Prints a comparison table with averages and per-task winners
4. Saves JSON results to `benchmarks/results/`

## How to run

```bash
bun run benchmarks/categories/abilities/model-quality.ts
```

Requires Ollama running with the target models pulled. Override defaults with env vars:

- `OLLAMA_URL` - Ollama endpoint (default: http://localhost:11434)
- `JUDGE_MODEL` - model used as quality judge (default: qwen3.5:latest)

## What it does NOT do

- Does not modify any existing files or benchmarks
- Does not change the model router - this is data collection only
- Does not use cloud APIs - local models only
- Does not run automatically in CI

## Expected output

A table like:

```
  Model                | Avg ms | Avg tok | Avg Quality | Best For
  ---------------------|--------|---------|-------------|----------
  qwen3.5:latest       |   2400 |     180 |        72.5 | explanation
  eight:latest         |   3100 |     210 |        68.0 | code-generation
  devstral:latest      |   1800 |     150 |        74.0 | architecture
```

## Success criteria

- All 3 models produce valid responses for all 4 task types
- Quality scores vary meaningfully across models (not all 50s)
- Results JSON is written successfully
- Data can feed into the existing model-router experience DB

## Files touched

- `benchmarks/categories/abilities/model-quality.ts` (new, ~140 lines)
- `quarantine/model-comparison.md` (new, this file)

No existing files modified.
