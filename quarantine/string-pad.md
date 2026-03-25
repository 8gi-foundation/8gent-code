# string-pad

**Status:** Quarantine - awaiting integration review

## What it does

ANSI-aware string padding for terminal output. Four exported functions covering
all common alignment needs, including multi-column table layout.

| Export | Behaviour |
|--------|-----------|
| `padStart(str, len, char?)` | Pad left - right-align text to `len` visible chars |
| `padEnd(str, len, char?)` | Pad right - left-align text to `len` visible chars |
| `padCenter(str, len, char?)` | Pad both sides - center text to `len` visible chars |
| `padColumns(rows, opts?)` | Auto-size columns from a 2D array, align per column |

Also exports `visibleWidth(str)` - strips ANSI and returns printable character count.

## Options

```ts
type Alignment = "left" | "right" | "center";

interface PadColumnsOptions {
  alignments?: Alignment[] | Alignment; // per-column or global. Default: "left"
  separator?: string;                   // column separator. Default: "  " (two spaces)
}
```

## ANSI awareness

All functions call `visibleWidth()` internally, which strips ANSI escape codes
before measuring. Colored terminal strings pad at the correct visible column -
the color sequences do not count toward width.

## Usage

```ts
import { padStart, padEnd, padCenter, padColumns } from "../packages/tools/string-pad";

// Right-align a number in a 6-char field
padStart("42", 6);         // "    42"

// Left-align with custom fill
padEnd("done", 10, ".");   // "done......"

// Center a label
padCenter("OK", 8);        // "   OK   "

// ANSI-colored string - pads by visible width, not byte length
const red = "\x1b[31mERROR\x1b[0m";
padEnd(red, 10);           // correctly adds 5 spaces after "ERROR"

// Multi-column table
const rows = [
  ["Name",    "Status",  "Score"],
  ["agent-1", "running", "98"],
  ["agent-2", "idle",    "74"],
  ["agent-3", "stopped", "0"],
];

const lines = padColumns(rows, {
  alignments: ["left", "left", "right"],
  separator: " | ",
});
// Name     | Status  |  Score
// agent-1  | running |     98
// agent-2  | idle    |     74
// agent-3  | stopped |      0
```

## File

`packages/tools/string-pad.ts` - 120 lines, zero dependencies.

## Integration candidates

- `apps/tui/src/lib/text.ts` - augment existing truncate helpers with padding
- `apps/tui/src/components/data-display/Table` - replace manual width logic
- Activity monitor tool feed - right-align timing columns
- Debugger panel - column-aligned key/value output
- Any TUI component using manual `" ".repeat(n)` width filling today
