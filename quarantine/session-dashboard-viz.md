# Session Dashboard Visualization - Concept Analysis

## Source

@poetengineer__ built a session dashboard for Claude Code: 254 sessions across 58 projects, 3D terrain map of token usage, session cards with prompts, click-to-resume in browser.

## The Session Terrain Concept

The core idea: represent coding sessions as a 3D terrain landscape where:

- **X axis** - time (session timeline, days/weeks)
- **Z axis** - session index or project grouping
- **Y axis (height)** - activity intensity (token count, tool calls, or duration)
- **Color** - maps to project, session type, or success/failure
- **Hover** - reveals session metadata (prompt, tools used, files changed, duration)

This turns flat session logs into a navigable topography. Peaks are intense sessions, valleys are quiet ones. You can visually spot patterns - heavy work weeks, project clusters, session types.

## How This Maps to Our Debugger (apps/debugger/)

The debugger app (`apps/debugger/`) is a Next.js app that currently shows:

- Session presentation views
- API routes for session data
- Component-based UI

The terrain visualization would slot in as a new view/route in the debugger, or as a standalone page in `apps/dashboard/`. The dashboard app is also Next.js with Tailwind, making it a natural home for an embedded Three.js canvas.

### Integration points

1. **Route:** `/terrain` or `/sessions/terrain` in either app
2. **Data source:** Same JSONL events the debugger already consumes
3. **Embedding:** Three.js canvas inside a Next.js page, or standalone HTML that loads via iframe

## What We Already Capture

Our observability hooks (`~/.claude/hooks/`) already collect rich session data:

### capture-all-events.ts

Writes every hook event to daily JSONL files at `$PAI_DIR/history/raw-outputs/YYYY-MM/YYYY-MM-DD_all-events.jsonl`.

Each event contains:
- `source_app` - which agent (main, subagent type)
- `session_id` - unique session identifier
- `hook_event_type` - event classification
- `payload` - full tool call data (tool name, inputs, outputs)
- `timestamp` + `timestamp_local` - precise timing
- Agent spawning metadata when subagents are created

### capture-session-summary.ts

On session end, generates a markdown summary with:
- Session focus (auto-classified: blog-work, hook-development, testing, deployment, etc.)
- Files changed (deduplicated, top 10)
- Commands executed (top 10)
- Tools used (unique set)
- Session ID and timing

### Data already available for terrain generation

| Dimension | Source | Field |
|-----------|--------|-------|
| Time (X) | all-events.jsonl | `timestamp` |
| Activity height (Y) | all-events.jsonl | count of events per session per time bucket |
| Session grouping (Z) | session summaries | `session_id`, `focus` |
| Color mapping | session summaries | `focus` category or project path |
| Hover details | session summaries | files changed, tools used, commands |
| Token usage | all-events.jsonl | `payload.token_count` if present, or proxy via event density |

## What We Need to Build

### Phase 1 - Standalone prototype (this PR)

- `apps/dashboard/src/SessionTerrain.html` - self-contained Three.js terrain with mock data
- Proves the visual concept works
- Brand colors (#E8610A orange accent, dark theme)
- Hover interaction for session details

### Phase 2 - Wire to real data

- API route in dashboard or debugger that reads JSONL event files
- Aggregates events into time buckets per session
- Returns JSON for the terrain grid
- Replace mock data with real API call

### Phase 3 - Full integration

- Embed in debugger app as a route
- Click-to-resume: link session IDs back to Claude Code session restore
- Filter by project, date range, agent type
- Side panel with session detail cards
- Export terrain as image for reports

### Dependencies

- Three.js (CDN, no install needed for standalone HTML)
- Existing JSONL data pipeline (already running)
- No new packages required for Phase 1
