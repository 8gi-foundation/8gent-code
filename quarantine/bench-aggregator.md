# Quarantine: Benchmark Aggregator

## Problem

Benchmark results are scattered across multiple JSON files in different formats under `benchmarks/`. No unified view of performance trends, regressions, or areas needing improvement.

## What it does

`packages/proactive/benchmark-aggregator.ts` reads all benchmark JSON files, normalizes three distinct formats (suite results, loop-state/autoresearch, model-experience), and produces a single aggregated report with:

- Overall average score and entry count
- Best and worst individual scores
- Per-category breakdown (avg, count, best, worst)
- Trend analysis (improving/declining/stable per category)
- Actionable improvement suggestions

## Usage

```bash
bun run packages/proactive/benchmark-aggregator.ts
```

Outputs a JSON report to stdout.

Programmatic:

```ts
import { aggregateBenchmarks } from "./packages/proactive/benchmark-aggregator.ts";
const report = await aggregateBenchmarks();
```

## Formats handled

| Source pattern | Parser |
|----------------|--------|
| `benchmarks/results/*.json` (suite results with `.results[]`) | `parseSuiteResult` |
| `benchmarks/autoresearch/loop-state*.json`, `autoresearch-report.json` (with `.history[]`) | `parseLoopState` |
| `benchmarks/autoresearch/model-experience.json` (with `.byDomain`) | `parseModelExperience` |

## Constraints

- Read-only - does not modify any benchmark files
- ~130 lines, zero external dependencies (Bun stdlib only)
- Skips unparseable files silently

## Exit criteria

- Wire into a TUI dashboard widget or CI report step
- Validate suggestions against actual improvement outcomes
