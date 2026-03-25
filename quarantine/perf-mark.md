# perf-mark

## Tool Name
`perf-mark`

## Description
Wrapper around the Web Performance API (`performance.mark` / `performance.measure`) with an internal store that works in Bun, Node, and browser environments.

- `mark(name)` - record a named timestamp at the current moment
- `measure(name, startMark, endMark?)` - compute duration between marks (or mark to now), returns ms
- `getMarks()` - return snapshot of all recorded marks
- `getMeasures()` - return snapshot of all recorded measures
- `clearAll()` - reset all marks and measures
- `report()` - return a human-readable formatted string with all durations

## Status
**quarantine** - self-contained, no external deps, not yet wired into any benchmark or agent pipeline.

## Integration Path
1. Import from `packages/tools/perf-mark.ts`
2. Wire into `benchmarks/autoresearch/harness.ts` to instrument loop phases (tool call, LLM response, write)
3. Optionally expose via `packages/eight/tools.ts` so agents can self-report timing breakdowns
4. Graduate from quarantine once used in at least one benchmark loop with measurable output
