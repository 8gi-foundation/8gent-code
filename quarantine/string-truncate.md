# string-truncate

**Status:** Quarantine - awaiting integration review

## What it does

Smart string truncation for terminal and UI output. Four exported functions:

| Export | Behaviour |
|--------|-----------|
| `truncate(str, maxLen, opts?)` | End-truncate with optional word-boundary break |
| `truncateStart(str, maxLen, opts?)` | Prepend ellipsis, keep tail |
| `truncateMiddle(str, maxLen, opts?)` | Keep head + tail, cut middle |
| `truncateWords(str, maxLen, opts?)` | End-truncate, always word-boundary |

## Options

```ts
interface TruncateOptions {
  ellipsis?: string;      // Default: "..."
  wordBoundary?: boolean; // Default: false (truncate/truncateWords only)
  minKeep?: number;       // Minimum visible chars kept. Default: 1
}
```

## ANSI awareness

All functions strip ANSI escape codes before measuring length, so colored
terminal strings truncate at the correct visible column.

## Usage

```ts
import { truncate, truncateMiddle, truncateStart, truncateWords } from "../packages/tools/string-truncate";

truncate("Hello world, this is a long line", 20);
// -> "Hello world, this is..."

truncateWords("Hello world, this is a long line", 20);
// -> "Hello world, this..."

truncateMiddle("/very/long/filesystem/path/to/some/file.ts", 25);
// -> "/very/long/fil.../file.ts"

truncateStart("fatal: repository not found at origin", 20);
// -> "...at origin"

// Custom ellipsis
truncate("something long here", 12, { ellipsis: " …" });
// -> "something l …"
```

## File

`packages/tools/string-truncate.ts` - 110 lines, zero dependencies.

## Integration candidates

- `apps/tui/src/lib/text.ts` - replace or delegate existing `truncate()` helper
- Activity monitor tool feed (long path/command display)
- Debugger panel output lines
- Any component using manual `.slice()` + `"..."` today
