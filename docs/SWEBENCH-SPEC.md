# SWE-bench Integration Spec

Status: SPEC (not yet implemented)
Owner: Benchmarks subagent
Issue: #943

## Problem

8gent has internal benchmarks but no externally-comparable score. SWE-bench Lite is the
industry standard for coding agents. Without a published score, 8gent has no credibility
signal in the market.

## What is SWE-bench Lite

- 300 real GitHub issues from 12 popular Python repos (django, sympy, scikit-learn, etc.)
- Each task: a failing test, a repo snapshot, and a gold patch
- Metric: **pass@1** - percentage of issues where the agent's patch makes all tests pass
- Dataset: `princeton-nlp/SWE-bench_Lite` on HuggingFace (already have `datasets` installed)

## Architecture

```
benchmarks/swebench/
  runner.ts          # Orchestrates task execution (Bun)
  docker-harness.sh  # Spins up isolated Docker containers per task
  scorer.ts          # Computes pass@1 from test results
  report.ts          # Generates JSON + markdown report
  config.yaml        # Model, concurrency, subset settings
```

### Execution flow

1. `runner.ts` loads tasks from HuggingFace `datasets` via Python bridge
2. For each task:
   a. Docker container with the repo at the correct commit
   b. 8gent agent receives: repo context, issue description, failing test
   c. Agent produces a git patch (unified diff)
   d. Patch applied inside container, test suite runs
   e. Result: pass/fail per task
3. `scorer.ts` aggregates pass/fail into pass@1 percentage
4. `report.ts` writes results to `benchmarks/swebench/results/`

### Integration with autoresearch

Wire into the existing harness-v2 loop by adding `swe-bench` as a `BenchmarkCategory`:

```typescript
// benchmarks/types.ts - add to BenchmarkCategory union
| "swe-bench"

// benchmarks/swebench/benchmarks.ts - export task definitions
export const sweBenchTasks: BenchmarkDefinition[] = loadFromDataset()
```

The autoresearch loop already supports prompt mutation based on scores. SWE-bench tasks
feed into the same mutation pipeline - when 8gent fails a task, the system prompt gets
a targeted patch and retries on the next loop iteration.

### Docker isolation (mandatory)

Each SWE-bench task MUST run in a Docker container:
- Base image: `python:3.11-slim` with repo dependencies
- No network access during patch generation (agent uses local model or cached context)
- 5-minute timeout per task
- Container destroyed after each task

This matches the official SWE-bench evaluation protocol.

## Scoring

```typescript
// scorer.ts
interface SWEBenchResult {
  taskId: string;        // e.g. "django__django-16379"
  repo: string;          // e.g. "django/django"
  passed: boolean;       // all tests pass after patch
  patchSize: number;     // lines changed
  durationMs: number;    // wall clock
  model: string;         // model used
}

interface SWEBenchReport {
  totalTasks: number;    // 300 for full Lite
  passed: number;
  passAt1: number;       // passed / totalTasks * 100
  byRepo: Record<string, { total: number; passed: number }>;
  timestamp: string;
  model: string;
  version: string;       // 8gent version
}
```

Pass@1 is the ONLY metric that matters for external comparison. Track per-repo breakdown
internally for debugging but publish only the aggregate.

## Comparison targets

| Agent | SWE-bench Lite pass@1 | Notes |
|-------|----------------------|-------|
| OpenHands (CodeAct) | ~49% | SOTA open source, March 2025 |
| Amazon Q Developer | ~46% | AWS backed |
| SWE-Agent | ~27% | Original baseline |
| Aider | ~26% | CLI agent |
| 8gent (target) | 15-20% | Realistic first run with free models |
| 8gent (goal) | 30%+ | After autoresearch prompt mutation |

Honest first-run expectation: 15-20% with free OpenRouter models. The autoresearch loop
should push this toward 30% over multiple iterations through prompt mutation.

## Publication

- **Machine-readable:** `benchmarks/swebench/results/latest.json` in repo
- **Human-readable:** Published to `8gent.world/benchmarks` via the 8gent-world repo
- **Format:** Score, model, date, version, link to full results JSON
- **Updates:** After each nightly run, auto-commit results and trigger 8gent-world deploy

## Automation

### Nightly cron (GitHub Actions)

```yaml
# .github/workflows/swebench-nightly.yml
name: SWE-bench Nightly
on:
  schedule:
    - cron: '0 3 * * *'  # 3 AM UTC daily
  workflow_dispatch: {}

jobs:
  swebench:
    runs-on: ubuntu-latest
    timeout-minutes: 360  # 6 hours for 300 tasks
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run benchmarks/swebench/runner.ts --subset 50
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      - run: bun run benchmarks/swebench/report.ts
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: 'bench: SWE-bench nightly results'
          file_pattern: benchmarks/swebench/results/
```

Start with `--subset 50` (random 50 tasks) to validate the pipeline before running
full 300. Full runs on weekends only to manage compute costs.

## Commands

```bash
# Run 10 tasks (smoke test)
bun run benchmarks/swebench/runner.ts --subset 10

# Run full Lite (300 tasks, ~4-6 hours)
bun run benchmarks/swebench/runner.ts

# Score existing results
bun run benchmarks/swebench/scorer.ts

# Generate report
bun run benchmarks/swebench/report.ts
```

## Constraints

- Docker required (no bare-metal repo checkouts - security risk)
- Free models only for nightly runs (paid models for one-off comparison runs)
- No string-matching for grading - test suite pass/fail is the only signal
- Results committed to repo, never manually edited
- First milestone: pipeline runs end-to-end on 10 tasks without crashing

## Not doing

- SWE-bench Full (2294 tasks) - too expensive for nightly, Lite is the standard
- SWE-bench Verified (500 tasks) - requires application to Princeton, do later
- Multi-agent orchestration for SWE-bench - single agent first, worktree pool later
- Custom Docker images per repo - use official SWE-bench containers if available

## Dependencies

- `datasets` Python package (installed, v4.7.0)
- Docker (for isolated task execution)
- OpenRouter API key (for model access)
- Existing harness-v2 infrastructure (types, grading patterns)
