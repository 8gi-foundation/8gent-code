# Quarantine: Performance Profiler

## Problem

No visibility into where Eight sessions spend time - thinking, tool calls, streaming. Without measurement, optimization is guesswork.

## What it does

`packages/proactive/profiler.ts` provides a `SessionProfiler` class that:

- Tracks time spent in each phase: thinking, tool execution, streaming, idle
- Records individual tool call durations and success/failure rates
- Captures streaming snapshots with token counts per model
- Compares local vs cloud model throughput (tok/s)
- Detects bottlenecks: slow tools (>5s avg), long thinking (>15s avg), low throughput (<10 tok/s)
- Outputs a structured `PerformanceReport` with actionable recommendations

## Usage

```typescript
import { SessionProfiler } from "./packages/proactive/profiler.ts";

const prof = new SessionProfiler("session-123");

prof.beginPhase("thinking");
// ... model thinks ...
prof.endPhase();

prof.beginTool("file_read");
// ... tool runs ...
prof.endTool(true);

prof.recordStream({ tokensGenerated: 450, durationMs: 3200, model: "qwen3.5", provider: "local" });

const report = prof.report();
console.log(SessionProfiler.formatReport(report));
```

## Integration path

Wire `beginPhase`/`endPhase` into the agent loop (`packages/eight/agent.ts`) around thinking, tool dispatch, and streaming phases. No existing files modified in this quarantine.

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/proactive/profiler.ts` | ~140 | Profiler class + report formatting |
| `quarantine/performance-profiler.md` | this file | Spec and integration notes |

## Success metric

After integration, every session can print a performance report showing where time was spent and what to optimize.

## Not doing

- Automatic integration into agent loop (requires touching existing files)
- Persistent storage of profiling data
- Real-time UI/dashboard
