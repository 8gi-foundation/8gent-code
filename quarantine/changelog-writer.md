# quarantine: changelog-writer

**Status:** quarantine - not yet wired into the agent or TUI

## What it does

`ChangelogWriter` builds Keep a Changelog-formatted release blocks from structured entry data. No string templates, no manual formatting - just typed calls that produce consistent output.

## Location

`packages/tools/changelog-writer.ts`

## API

```ts
import { ChangelogWriter } from "./packages/tools/changelog-writer";

const cw = new ChangelogWriter()
  .setVersion("1.5.0")
  .setDate("2026-03-25")
  .addBreaking("Removed legacy --model flag - use --provider instead")
  .addEntry("Added", "Structured changelog writer tool")
  .addEntry("Fixed", "ANSI padding edge case on empty strings")
  .addEntry("Changed", "Default model selection now uses task router");

console.log(cw.toString());
```

Output:

```
## [1.5.0] - 2026-03-25

### BREAKING CHANGES
- Removed legacy --model flag - use --provider instead

### Added
- Structured changelog writer tool

### Changed
- Default model selection now uses task router

### Fixed
- ANSI padding edge case on empty strings
```

## Methods

| Method | Description |
|--------|-------------|
| `setVersion(ver)` | Version string, e.g. "1.5.0" |
| `setDate(date)` | ISO date string "YYYY-MM-DD" |
| `addEntry(type, description)` | One of: Added, Changed, Deprecated, Removed, Fixed, Security |
| `addBreaking(description)` | Breaking change - rendered first under its own section |
| `toString()` | Renders the full block as a string |

All methods return `this` for chaining.

## Wire-up candidates

- `packages/self-autonomy/reflection.ts` - post-session changelog generation
- `scripts/generate-all-artifacts.ts` - automated release notes
- Agent tool: `write_changelog` that calls this internally
