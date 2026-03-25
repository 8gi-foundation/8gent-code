# event-timeline

## Tool Name
`event-timeline`

## Description
Records timestamped events (marks) and durations (spans) during agent sessions, then renders an ASCII timeline visualization. Useful for debugging agent session flow, measuring tool latency, and understanding where time is spent across a task.

## Status
`quarantine` - standalone, not yet wired into the agent loop or TUI.

## Usage

```typescript
import { Timeline } from "../packages/tools/event-timeline.ts";

const t = new Timeline();

t.mark("session.start");

const result = await t.span("tool.readFile", async () => {
  // ... do work
  return "contents";
});

t.mark("session.end");

console.log(t.format()); // ASCII visualization
```

## Integration Path

1. **Agent loop** - inject a `Timeline` instance per session in `packages/eight/agent.ts`, mark tool calls and LLM turns as spans, emit the formatted timeline on session end.
2. **Debugger** - surface span data in `apps/debugger/` as a real-time waterfall view.
3. **Memory** - store span summaries as episodic memories in `packages/memory/store.ts` so Eight learns which tools are slow.
4. **Benchmark harness** - wrap each benchmark step in `t.span()` to produce structured timing data alongside benchmark scores.

## Files
- `packages/tools/event-timeline.ts` - `Timeline` class, `TimelineMark`, `TimelineSpan` types, convenience `timeline` singleton.
