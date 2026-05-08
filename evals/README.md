# 8gent Evals

Golden test sets and measurement baselines for agent output. Closes [#2421](https://github.com/8gi-foundation/8gent-code/issues/2421).

> "You can't optimize what you don't measure." - Rob Pike's Rule 1

## What this is

A small, focused harness for measuring **regression** in agent output quality and latency. It is NOT a replacement for the broader `benchmarks/` suite (which is a model-vs-model bake-off). This is a pre-merge gate: did your change make the agent dumber or slower?

## Layout

| Path | Purpose |
|------|---------|
| `evals/golden-set.json` | 22 curated test cases, 5 categories |
| `evals/baseline.json` | Snapshot of the last "known good" run |
| `evals/report.json` | Last run's full report (gitignored) |
| `packages/evals/` | Runner, scorer, baseline-diff, CLI |

## Running

```bash
# Run golden set; print summary
bun run evals

# Run, write full report
bun run evals --output evals/report.json

# Update baseline (only when intentional improvement is verified)
bun run evals --baseline

# CI mode: compare to baseline, exit 1 on regression
bun run evals --check

# Filter
bun run evals --category tool_use
bun run evals --case TC001 --verbose
```

## Environment

| Var | Purpose |
|-----|---------|
| `OPENROUTER_API_KEY` | Required for real model. Falls back to mock executor if absent. |
| `EVALS_MODEL` | Override model (default `qwen/qwen-2.5-72b-instruct:free`) |
| `EVALS_JUDGE_API_KEY` | Enables LLM-as-judge for `quality_rubric` cases. Defaults to `OPENROUTER_API_KEY`. |
| `EVALS_USE_MOCK=1` | Force mock executor (CI without API keys) |

No keys present? The mock executor returns a deterministic stub. Useful for verifying the runner itself without burning tokens.

## Schema

Each case in `golden-set.json`:

```ts
interface GoldenTestCase {
  id: string;
  name: string;
  category: 'tool_use' | 'reasoning' | 'code_gen' | 'memory' | 'multi_step';
  prompt: string;
  context?: string;       // optional preloaded session context
  expected: {
    contains?: string[];      // case-insensitive substring presence
    not_contains?: string[];  // case-insensitive substring absence
    tool_calls?: string[];    // tools that should appear in the trace
    file_outputs?: string[];  // files that should be touched
    quality_rubric?: string;  // free-form rubric for LLM-as-judge
  };
  timeout_ms: number;
}
```

## Scoring

A case **passes** when every defined check passes. Score is a weighted blend (0-100):

| Check | Weight |
|-------|--------|
| `contains` | 30 |
| `not_contains` | 20 |
| `tool_calls` | 20 |
| `file_outputs` | 15 |
| `quality_rubric` (LLM judge) | 30 |

Per CLAUDE.md's AI Judging Rule, only **string-presence** checks use literal matching. Quality judgments go through the LLM-as-judge in `packages/evals/scorer.ts`.

## Regression rules

A run regresses against baseline when **any** of the following holds for any case:

- A case that passed in baseline now fails (`passing` regression)
- Score drops by more than `SCORE_REGRESSION_THRESHOLD` (5 points)
- Latency exceeds baseline by more than `LATENCY_REGRESSION_RATIO` (1.5x)

CI exits 1 on any regression. Update baseline only after verifying the change is intentional:

```bash
bun run evals --baseline
git add evals/baseline.json
```

## Adding cases

1. Add a new entry to `evals/golden-set.json` with a fresh `TC###` id
2. Run `bun run evals --case TC0NN --verbose` to verify
3. Re-snapshot baseline: `bun run evals --baseline`

## Executor backends

`packages/evals/executor.ts` is a small interface:

```ts
interface AgentExecutor {
  name: string;
  execute(prompt: string, context?: string): Promise<AgentExecutionResult>;
}
```

The default `selectExecutor()` chooses OpenRouter (real model) or a mock. Future executors can wrap the daemon's WebSocket protocol or the `packages/eight/harness` API for end-to-end tool-using runs.
