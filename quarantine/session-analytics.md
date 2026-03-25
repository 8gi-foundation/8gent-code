# Session Analytics

**Status:** Quarantine
**Package:** `packages/proactive/session-analytics.ts`
**Inspired by:** @poetengineer__'s Claude Code session dashboard

## Problem

No visibility into how 8gent sessions are performing over time - token usage, tool patterns, success rates, or which types of prompts resolve fastest.

## What it does

Reads the existing observability data that 8gent already writes:

- `~/.8gent/runs.jsonl` - one JSON line per agent turn (tokens, tools, duration, status, model, prompt)
- `~/.8gent/sessions/*.jsonl` - granular event logs per session (tool_call events with tool names)

Produces a structured `AggregateReport` with:

1. **Per-session metrics** - duration, tokens, tool calls, success rate, model, files touched
2. **Cross-session aggregates** - avg session length, total tokens, overall success rate
3. **Tool usage ranking** - which tools are called most (from granular session logs)
4. **Peak hours** - when sessions happen most frequently
5. **Model usage** - which models are used and their token consumption
6. **Prompt pattern analysis** - classifies prompts (fix/create/review/refactor/test/short-command) and ranks by average completion speed

## Usage

```bash
# Default: last 7 days
bun run packages/proactive/session-analytics.ts

# Last 30 days
bun run packages/proactive/session-analytics.ts 30
```

Programmatic:

```typescript
import { generateReport } from "./packages/proactive/session-analytics.ts";
const report = generateReport(7);
// report.sessions, report.toolUsageRanking, report.peakHours, etc.
```

## Constraints

- Read-only - never writes to ~/.8gent/
- Zero dependencies beyond Node stdlib (fs, path, os)
- ~150 lines, single file
- No modifications to existing files

## Exit criteria

- [ ] Wire into TUI as a `/analytics` command
- [ ] Add time-series charting (sparklines in terminal)
- [ ] Feed patterns back into prompt optimization (autoresearch integration)
