# debug-timer

## Tool Name
`debug-timer`

## Description
Measures and logs execution time of named code blocks. Supports nested timers (parent-child relationships tracked on a stack), async function wrapping, automatic per-call logging on stop, aggregate stats across multiple runs, and flame-chart style output showing the call tree with visual duration bars.

## Status
**quarantine** - standalone, not yet wired into the agent tool registry.

## Exports
- `timer(name)` - start a named timer; tracks nesting depth and parent automatically
- `timerStop(name, log?)` - stop timer, print duration, return elapsed ms
- `timeAsync(name, fn)` - wrap an async function with start/stop timing
- `TimerReport` - generate flame-chart output and aggregate stats from session history
  - `.flameChart()` - indented tree with Unicode bar proportional to duration
  - `.aggregateStats()` - table of calls, min, avg, max, total per name
  - `TimerReport.reset()` - clear all history and aggregates

## Integration Path
1. Register in `packages/eight/tools.ts` as a dev/debug tool under the `profiling` category.
2. Wire a `/profile` or `/timer` slash command in the TUI command palette.
3. Optionally persist flame-chart output to `.8gent/profiling/` alongside session logs for post-session analysis.
4. Consider integrating with `packages/self-autonomy/reflection.ts` so slow tool calls are flagged during post-session reflection.
