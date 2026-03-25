# Quarantine: ascii-progress

## What

Self-contained ASCII-only progress indicators for non-TTY log environments. Provides progress bars, dot indicators, percentages, fractions, a rotating spinner, and a combined status line. No Unicode, no ANSI escape codes, no terminal dependencies - safe for CI logs, file output, piped streams, and headless pipelines.

## File

`packages/tools/ascii-progress.ts` (~110 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import {
  asciiBar,
  dots,
  percentage,
  fraction,
  spinner,
  statusLine,
} from './packages/tools/ascii-progress.ts';

// Progress bar
asciiBar(5, 10)        // "[=====>    ] 50%"
asciiBar(10, 10)       // "[==========] 100%"
asciiBar(0, 10)        // "[>         ] 0%"
asciiBar(3, 10, 20)    // "[=====>              ] 30%"

// Dots
dots(3, 10)            // "..."
dots(10, 10)           // ".........."

// Percentage
percentage(1, 3)       // "33%"
percentage(3, 3)       // "100%"

// Fraction
fraction(5, 10)        // "5/10"
fraction(7, 7)         // "7/7"

// Spinner (rotate by frame index, wraps at 4)
spinner(0)             // "|"
spinner(1)             // "/"
spinner(2)             // "-"
spinner(3)             // "\\"

// Combined status line
statusLine(2, 5, 1)    // "/ [==>      ] 2/5 40%"
```

## Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `asciiBar` | `(current, total, width?) => string` | Filled bar with arrow head and percentage |
| `dots` | `(current, total) => string` | Dot string scaled to progress |
| `percentage` | `(current, total) => string` | Integer percentage string |
| `fraction` | `(current, total) => string` | "n/total" fraction string |
| `spinner` | `(frame) => string` | Single char from `|/-\` cycle |
| `statusLine` | `(current, total, frame, width?) => string` | Spinner + bar + fraction + percentage |

## Integration path

- [ ] Add export to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: bar boundaries (0%, 50%, 100%), width variants, spinner wrap at frame 4, fraction with zero total, statusLine format
- [ ] Use in benchmark harness (`benchmarks/autoresearch/`) for CI-safe progress output
- [ ] Consider wiring into daemon job queue progress reporting (`packages/memory/store.ts` lease jobs)
- [ ] Evaluate adding `compact` option to `statusLine` that omits the bar for narrow log lines
