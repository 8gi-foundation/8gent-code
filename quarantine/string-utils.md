# Quarantine: string-utils

**File:** `packages/tools/string-utils.ts`
**Branch:** `quarantine/string-utils`
**Status:** Quarantined - not wired into any existing module

## What it is

10 pure string utility functions with zero dependencies:

| Function | Purpose |
|----------|---------|
| `truncate` | Shorten string with suffix ("...") |
| `wordWrap` | Break text at word boundaries to fit a column width |
| `slugify` | URL/filename-safe slug from any string |
| `camelCase` | Convert any casing to camelCase |
| `snakeCase` | Convert any casing to snake_case |
| `titleCase` | Capitalize first letter of each word |
| `stripAnsi` | Remove ANSI escape sequences |
| `padCenter` | Center-pad a string within a given width |
| `pluralize` | "1 file" / "3 files" with optional irregular plural |
| `humanizeBytes` | Bytes to human-readable ("1.5 KB") |

## Why quarantined

- Not yet imported by any package or app
- Needs tests before promotion
- Some functions overlap with `apps/tui/src/lib/text.ts` - need to deduplicate before merging

## Promotion criteria

1. Unit tests covering edge cases (empty strings, zero-width, negative bytes, unicode)
2. Deduplicate with existing `truncate` / `wrapText` in TUI lib
3. Wire into at least one consumer (e.g. replace inline formatting in TUI screens)
4. Confirm no bundle size regression in TUI build
