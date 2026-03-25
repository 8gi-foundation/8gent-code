# Quarantine: Model Routing Tests

## What

Benchmark suite for the model router that selects the best LLM per task.
Tests the provider system (`packages/providers/index.ts`) and the experience-based
router (`benchmarks/autoresearch/model-router.ts`).

## File

`benchmarks/categories/abilities/model-routing.ts`

## Tests (7)

| # | Test | What it validates |
|---|------|-------------------|
| T1 | Local model default | Fresh install defaults to 8gent/ollama, not cloud |
| T2 | Cloud escalation | Enabling + activating openrouter works |
| T3 | Free-tier preference | `resolveModel("auto:free")` returns an openrouter free model |
| T4 | Passthrough | Specific model strings are not altered |
| T5 | Failover on missing key | `chat()` throws a clear error when API key is absent |
| T6 | Experience ranking | `getModelOrder` puts highest-scoring model first |
| T7 | Cold start exploration | Untried models rank above low-scoring tried models |

## Run

```bash
bun run benchmarks/categories/abilities/model-routing.ts
```

Or import and call `run()` from the harness.

## Graduation criteria

- All 7 tests pass consistently
- No flaky network dependency (T3 has a built-in fallback)
- Reviewed and merged to main

## Risk

- T3 calls `resolveModel("auto:free")` which may hit the OpenRouter models API.
  The function has a fallback for network errors, so this should not flake.
- T6/T7 write to the shared `model-experience.json`. In CI, use a temp copy or
  accept the side effect (the file is gitignored-equivalent - already dirty).
