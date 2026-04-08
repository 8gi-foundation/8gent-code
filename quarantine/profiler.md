# Quarantine: Function-Level Performance Profiler

**Branch:** `quarantine/profiler`
**File:** `packages/tools/profiler.ts`
**Status:** Quarantine - ready for wiring when needed

## What It Does

Zero-dependency function-level profiler for Eight. Wraps sync or async functions with timing instrumentation. Tracks call counts and latency stats (avg, min, max, p95) per function. Supports nested spans for hierarchical profiling (e.g., agent loop > tool call > file read).

## API

```ts
import { Profiler, profiler } from "./packages/tools/profiler.ts";

// Module-level singleton
const wrapped = profiler.wrap("myFn", myFn);
await wrapped(arg1, arg2);

// Manual spans
profiler.start("db:query");
const rows = db.query("SELECT ...");
profiler.end("db:query");

// Stats
profiler.report();               // console table
profiler.getStats("myFn");       // single FunctionStats
profiler.getAllStats();           // all, sorted by total time
profiler.toJSON();               // { stats, spans } for persistence

// Nested spans (parent/child recorded automatically via stack)
profiler.start("agent:loop");
  profiler.start("tool:read_file");
  profiler.end("tool:read_file");
profiler.end("agent:loop");
```

## Exported Types

| Type | Description |
|------|-------------|
| `FunctionStats` | name, calls, totalMs, minMs, maxMs, avgMs, p95Ms |
| `Span` | name, startMs, endMs, durationMs, parentName, children |
| `Profiler` | Main class |
| `profiler` | Module-level singleton instance |

## Integration Points (when wiring)

- `packages/eight/agent.ts` - wrap the agent loop, tool dispatch, and stream handlers
- `packages/tools/index.ts` - wrap individual tool handlers to surface per-tool latency
- `packages/memory/store.ts` - wrap query/write methods to detect slow memory ops
- TUI debugger panel - consume `profiler.getAllStats()` and render as a table

## Why Quarantine

Not wired into any existing code. No existing file was modified. Ship as-is and connect when there is a specific performance investigation to run. The module-level `profiler` singleton means wiring is a one-liner import and wrap per function.

## Success Metric

Usable when: wrapping `agent.ts` tool dispatch reveals which tools account for >50% of wall-clock time in a benchmark run.
