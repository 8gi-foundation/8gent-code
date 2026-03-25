# quarantine/ansi-strip

## What

ANSI escape code stripper and visible string width calculator for terminal output. Strips SGR color/style codes, measures rendered column width (including wide CJK characters), detects ANSI presence, and truncates strings to a column budget while preserving escape sequences.

## Status

`quarantine` - implemented, not yet wired into TUI layout or primitives.

## Location

`packages/tools/ansi-strip.ts` (~140 lines)

## API

```ts
import {
  stripAnsi,
  visibleWidth,
  hasAnsi,
  charWidth,
  truncateAnsi,
} from "./packages/tools/ansi-strip";

stripAnsi("\x1b[32mhello\x1b[0m");             // "hello"
hasAnsi("\x1b[32mhello\x1b[0m");               // true
visibleWidth("\x1b[32mhello\x1b[0m");          // 5
visibleWidth("你好");                           // 4 (CJK = 2 cols each)
truncateAnsi("\x1b[32mhello world\x1b[0m", 8); // "\x1b[32mhello\x1b[0m..."
```

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `stripAnsi` | `(str: string) => string` | Remove all ANSI escape sequences |
| `hasAnsi` | `(str: string) => boolean` | Detect if string contains ANSI codes |
| `visibleWidth` | `(str: string) => number` | Column width after stripping ANSI |
| `charWidth` | `(char: string) => 0 \| 1 \| 2` | Width of a single Unicode character |
| `truncateAnsi` | `(str, maxWidth, ellipsis?) => string` | Truncate to column budget, preserving codes |

## Design decisions

- Zero runtime dependencies - only regex and Unicode range tables.
- `ANSI_PATTERN` covers SGR (colors/bold), cursor movement, and OSC sequences (hyperlinks).
- Wide character detection uses Unicode range tables, not a lookup lib, to keep the tool self-contained.
- `truncateAnsi` walks the string token-by-token so escape sequences are never split or counted toward the visible budget.
- `charWidth` returns `0 | 1 | 2` matching the wcwidth convention used by terminal emulators.

## Integration path

1. Wire `truncateAnsi` into `apps/tui/src/lib/text.ts` `truncate()` helper so all TUI text truncation is ANSI-aware.
2. Replace any raw `.length` checks on colored strings in `packages/eight/` with `visibleWidth()`.
3. Use in the debugger and activity monitor panels where log lines may contain color codes from sub-processes.
4. Export from `packages/tools/index.ts` once integrated and verified in production terminal emulators.

## Graduation criteria

- Unit tests confirming correct widths for plain ASCII, CJK ideographs, colored strings, and OSC hyperlink sequences.
- Integration test: TUI column layout does not overflow when lines contain ANSI codes.
- Verified on iTerm2, Terminal.app, and VS Code integrated terminal.
