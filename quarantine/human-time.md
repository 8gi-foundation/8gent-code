# human-time

**Tool name:** human-time
**Status:** quarantine

## Description

Formats dates and durations as human-friendly relative time strings. No dependencies - pure TypeScript.

Exported functions:

- `timeAgo(date, base?)` - how long ago a date was ("5 minutes ago", "2 hours ago", "just now")
- `timeUntil(date, base?)` - how far in the future a date is ("in 5 minutes", "in 2 hours")
- `humanDuration(ms)` - formats a millisecond duration ("1 hour 30 minutes", "45 seconds")
- `formatRelative(date, base?)` - auto-selects past or future phrasing
- `isRecent(date, thresholdMs?)` - returns true if within threshold (default 5 minutes)

## Integration Path

Once validated, wire into:

1. `packages/tools/index.ts` - export alongside other tool utilities
2. `apps/tui/src/` - use in activity feed timestamps, session start/elapsed display
3. `packages/memory/store.ts` - format memory ages in debug output
4. `packages/eight/agent.ts` - format checkpoint ages and session durations in status messages

## Notes

- All functions accept `Date` or epoch milliseconds - no coercion required
- `timeAgo` and `timeUntil` gracefully handle inverted dates (past/future swap)
- `humanDuration` shows max 2 significant units (e.g. "1 hour 30 minutes", not "1 hour 30 minutes 5 seconds")
- Threshold boundaries match UX conventions (e.g. "just now" for < 10 seconds)
