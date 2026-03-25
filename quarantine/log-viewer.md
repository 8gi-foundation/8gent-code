# Quarantine: Log Viewer

## What

Terminal debug log viewer for Eight's log files. Reads daemon.log, runs.jsonl, and failure logs with level filtering, text search, tail mode, and colorized output.

## File

`packages/tools/log-viewer.ts` (~110 lines)

## Status

**Quarantined** - not wired into TUI or CLI entry points. Standalone script only.

## Usage

```bash
# Last 40 lines of daemon.log (default)
bun run packages/tools/log-viewer.ts

# Live tail
bun run packages/tools/log-viewer.ts --tail

# Filter by level
bun run packages/tools/log-viewer.ts --level error

# Search for text
bun run packages/tools/log-viewer.ts --search "session"

# View runs log
bun run packages/tools/log-viewer.ts --file runs

# Custom line count
bun run packages/tools/log-viewer.ts --lines 100
```

## Log files supported

| Key | Path | Format |
|-----|------|--------|
| `daemon` | `~/.8gent/daemon.log` | `ISO [event:type] {json}` per line |
| `runs` | `~/.8gent/runs.jsonl` | One JSON object per agent run |
| `failures` | `~/.8gent/healing/failures.jsonl` | One JSON object per healer failure |

## Level classification

Lines are classified by regex pattern matching on known event types:

- **error** - `agent:error`, `fatal`, `panic`, `exception`
- **warn** - `warning`, `timeout`, `retry`
- **info** - `session:*`, `tool:result`, `memory:saved`, `[daemon]`
- **debug** - `tool:start`, `agent:thinking`, `agent:stream`

## Graduation criteria

- [ ] Wire into `8gent logs` CLI subcommand
- [ ] Add to TUI as a debug panel
- [ ] Add JSON pretty-print mode for runs/failures
- [ ] Add date range filtering
