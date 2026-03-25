# duration-formatter

**Status:** Quarantine - awaiting integration review

## What it does

Millisecond-to-human duration formatting, duration string parsing, and simple duration arithmetic. Five exported functions:

| Export | Behaviour |
|--------|-----------|
| `formatMs(ms, opts?)` | Formats a millisecond value into a human-readable string (compact, long, or precise mode) |
| `parseDuration(str)` | Parses a duration string like "2h 30m" or "1 hour 30 minutes" into milliseconds |
| `addDurations(a, b)` | Adds two durations (strings or ms numbers), returns milliseconds |
| `subtractDurations(a, b)` | Subtracts duration b from a, returns milliseconds (may be negative) |
| `compareDurations(a, b)` | Compares two durations; returns -1, 0, or 1 |

## Options

```ts
type FormatMode = "compact" | "long" | "precise";

interface FormatMsOptions {
  mode?: FormatMode;       // Default: "compact"
  maxSegments?: number;    // Max unit segments to include (default: all)
}
```

## Modes

| Mode | Example output |
|------|---------------|
| `compact` (default) | `"2h 30m 5s"` |
| `long` | `"2 hours 30 minutes 5 seconds"` |
| `precise` | `"2h 30m 5s 120ms"` (includes sub-second millis) |

## Usage

```ts
import {
  formatMs,
  parseDuration,
  addDurations,
  subtractDurations,
  compareDurations,
} from "../packages/tools/duration-formatter";

// Formatting
formatMs(9005120);                            // "2h 30m 5s"
formatMs(9005120, { mode: "long" });          // "2 hours 30 minutes 5 seconds"
formatMs(9005120, { mode: "precise" });       // "2h 30m 5s 120ms"
formatMs(500);                                // "500ms"
formatMs(9005120, { maxSegments: 2 });        // "2h 30m"

// Parsing
parseDuration("2h 30m");                      // 9000000
parseDuration("1d 6h 15m 30s");              // 108930000
parseDuration("1 hour 30 minutes");           // 5400000
parseDuration("500ms");                       // 500

// Arithmetic
addDurations("1h", "30m");                    // 5400000
subtractDurations("2h", "30m");               // 5400000
subtractDurations("30m", "1h");              // -1800000

// Comparison
compareDurations("1h", "30m");               // 1
compareDurations("30m", "1h");              // -1
compareDurations("60m", "1h");              // 0
```

## File

`packages/tools/duration-formatter.ts` - 140 lines, zero dependencies.

## Integration candidates

- `apps/tui/src/lib/format.ts` - replace or augment existing `formatDuration()` in `number-formatter.ts` (which only does compact mode with no parse/arithmetic)
- Benchmark harness - elapsed time display in compact/precise mode
- Activity monitor - tool call durations
- Kernel training loop - epoch/step timing display
- Any component that today uses ad hoc `Date.now()` subtraction with manual string building
