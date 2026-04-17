# duration-parser

**Status:** quarantine

## Description

Parses human-readable duration strings to milliseconds and formats milliseconds back to human-readable strings.

Supported units: `ms`, `s`, `m`, `h`, `d`, `w` - composable (e.g. `2h30m`, `1d12h`).

## Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `parseDuration` | `(str: string) => number` | Parse duration string to ms |
| `formatDuration` | `(ms: number) => string` | Format ms to human string |
| `Duration` | `class` | Immutable value object with add, subtract, compare |

## Usage

```ts
import { parseDuration, formatDuration, Duration } from "../packages/tools/duration-parser.ts";

parseDuration("2h30m")         // 9000000
parseDuration("500ms")         // 500
parseDuration("1d12h")         // 129600000
formatDuration(9000000)        // "2h30m"
formatDuration(500)            // "500ms"

const d = new Duration("1h");
d.add("30m").toString()        // "1h30m"
d.subtract("15m").toString()   // "45m"
d.isGreaterThan("30m")         // true
```

## Integration Path

1. Wire into `packages/eight/tools.ts` as a tool callable by the agent.
2. Use in `packages/orchestration/` for timeout and scheduling arithmetic.
3. Expose via `packages/music/` for track duration display and crossfade timing.
4. Add to `packages/memory/` for TTL/lease duration handling.

## Notes

- Self-contained, zero dependencies, ~140 lines.
- Immutable Duration class prevents accidental mutation.
- Floors subtraction at 0 (no negative durations).
- Rounds to nearest millisecond on fractional inputs.
