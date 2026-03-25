# Date/Time Utilities

## Status: Quarantine

**File:** `packages/tools/datetime.ts`

## Problem

Multiple packages format timestamps, compute relative times, or check scheduling constraints with ad-hoc inline logic. No shared date/time utility exists, leading to inconsistent formatting and duplicated code.

## What it does

Five pure utility functions for common date/time operations. Zero external dependencies - uses only built-in `Date`.

- **timeAgo(date, now?)** - human-readable relative time ("3h ago", "just now", "2 weeks ago")
- **formatDuration(ms)** - compact duration string ("2h 15m 3s", "450ms")
- **parseRelativeDate(input, now?)** - parse "2h ago" or "in 3 days" into a Date
- **isBusinessHours(date?, opts?)** - check if a timestamp falls within Mon-Fri working hours
- **nextWorkday(from?, atHour?)** - find the next weekday at a given hour

## API

```ts
import { timeAgo, formatDuration, parseRelativeDate, isBusinessHours, nextWorkday } from "@8gent/tools/datetime";

timeAgo(new Date(Date.now() - 3600000));   // "1h ago"
formatDuration(7_263_000);                  // "2h 1m 3s"
parseRelativeDate("30m ago");              // Date 30 minutes in the past
isBusinessHours(new Date("2026-03-25T14:00")); // true (Wednesday 2pm)
nextWorkday(new Date("2026-03-28T18:00")); // Monday 2026-03-30 at 09:00
```

## Constraints

- No external dependencies
- Pure functions only - no side effects, no state
- All time math uses millisecond constants, no string parsing of ISO dates
- ~80 lines total

## Integration points

- `packages/memory/` - formatting memory timestamps in queries
- `packages/self-autonomy/reflection.ts` - session duration formatting
- `packages/proactive/` - business hours checks for notifications
- `apps/tui/` - relative timestamps in chat UI

## Exit criteria

- Used by at least 2 packages
- Replaces existing inline date formatting in those packages
