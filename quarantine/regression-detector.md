# Quarantine: Regression Detector

**Status:** Quarantined - needs integration testing with real benchmark runs before promotion.

## What it does

`packages/validation/regression-detector.ts` compares two benchmark JSON files (autoresearch loop-state format) and flags per-task performance regressions exceeding a configurable threshold (default 10%).

## Usage

```bash
# Compare two benchmark snapshots
bun run packages/validation/regression-detector.ts benchmarks/autoresearch/loop-state-pre.json benchmarks/autoresearch/loop-state.json

# Custom threshold (5%)
bun run packages/validation/regression-detector.ts baseline.json current.json 5
```

Exit code 1 if regressions detected, 0 if clean.

## Programmatic API

```ts
import { detectRegressions, formatReport } from "./packages/validation/regression-detector";

const report = detectRegressions("baseline.json", "current.json", 10);
console.log(formatReport(report));

if (report.regressions.length > 0) {
  // handle regressions
}
```

## Report structure

- **regressions** - tasks that dropped more than threshold%
- **improvements** - tasks that improved more than threshold%
- **stable** - tasks within threshold
- **aggregateRegressed** - whether the overall average score regressed

## Graduation criteria

- [ ] Tested against at least 3 real loop-state file pairs
- [ ] Integrated into CI or overnight benchmark runner
- [ ] Edge cases handled: missing tasks, zero scores, single-iteration files
- [ ] Exported from `packages/validation/index.ts`
