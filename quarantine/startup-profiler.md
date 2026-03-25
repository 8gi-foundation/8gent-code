# Quarantine: Startup Profiler

## Status: Quarantined

Not wired into any existing code. Isolated in `packages/validation/startup-profiler.ts` for evaluation.

## Problem

No visibility into what makes TUI or daemon startup slow. No data on cold vs warm start differences or which imports are bottlenecks.

## What it does

- Measures total startup time for TUI (`apps/tui/src/index.tsx`) or daemon (`packages/daemon/index.ts`)
- Identifies slow imports above a configurable threshold (default 50ms)
- Tracks cold vs warm start (cold = no run in last 5 minutes)
- Appends results to `.8gent/startup-profile.json` (keeps last 50 runs)
- `summarizeProfiles()` returns avg cold/warm times and a trend (improving/stable/degrading)

## Usage

```ts
import { profileStartup, summarizeProfiles } from "@8gent/validation/startup-profiler";

// Profile a single startup
const report = await profileStartup({ target: "tui" });
console.log(report.totalMs, report.slowImports);

// Get trend summary
const summary = summarizeProfiles();
console.log(summary.trend, summary.avgColdMs);
```

## Constraints

- Does not modify any existing files
- Uses `bun build` for import resolution timing - not a full runtime profile
- Slow import detection depends on bun's build output format (may need adjustment as bun evolves)

## Success metric

Able to identify the top 3 slowest imports in the TUI startup path and track whether startup time improves or degrades across sessions.

## Files

- `packages/validation/startup-profiler.ts` (~150 lines)
- `quarantine/startup-profiler.md` (this file)
