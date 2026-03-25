# perf-counter

## Tool Name
`perf-counter`

## Description
Class-based performance counter with named checkpoints, nested counters, and formatted output. Distinct from `perf-mark.ts` (module-level Web Perf API wrapper) - this is instance-based so you can track multiple concurrent operations independently.

- `new PerfCounter(name, autoLog?)` - create a counter; autoLog prints each checkpoint to console
- `start()` - begin timing; resets state if called again
- `checkpoint(name)` - record a named stage; captures elapsed and delta since previous checkpoint
- `stop()` - stop timing; returns total ms
- `elapsed()` - total ms from start to stop (or now if still running)
- `checkpoints()` - readonly snapshot of all recorded checkpoints
- `child(name)` - create and register a nested child counter (appears indented in format output)
- `reset()` - clear all state and children
- `summary()` - structured `PerfSummary` object (JSON-serializable)
- `format()` - human-readable report with per-checkpoint delta and cumulative elapsed

`perf(name, autoLog?)` - factory that creates and immediately starts a counter.

## Status
**quarantine** - self-contained, no external deps, not yet wired into any benchmark or agent pipeline.

## Integration Path
1. Import from `packages/tools/perf-counter.ts`
2. Wire into `benchmarks/autoresearch/harness.ts` to instrument per-loop phases (tool call, LLM response, write) as named checkpoints on a single counter per run
3. Use `child()` counters inside `packages/orchestration/` to track per-worktree timing
4. Optionally expose via `packages/eight/tools.ts` so agents can self-report timing breakdowns to the user
5. Graduate from quarantine once used in at least one benchmark loop with measurable checkpoint output
