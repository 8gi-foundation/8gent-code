# quarantine: diff-view

**Status:** Quarantine - awaiting review before wiring into main agent loop.

## What it is

`packages/tools/diff-view.ts` - a zero-dependency unified diff parser and side-by-side terminal renderer.

## Exports

| Symbol | Signature | Purpose |
|--------|-----------|---------|
| `parseDiff` | `(raw: string) => DiffFile[]` | Parse a unified diff string into structured data |
| `renderSideBySide` | `(files: DiffFile[], opts?: RenderOptions) => string` | Render parsed diff as ANSI-colored side-by-side terminal output |

## Key types

```ts
DiffFile   { fromPath, toPath, isNew, isDeleted, isBinary, hunks }
DiffHunk   { oldStart, oldCount, newStart, newCount, heading, lines }
DiffLine   { type: "context"|"added"|"removed"|"noNewline", content, oldLineNo, newLineNo }
RenderOptions { width?, lineNumbers?, wordHighlight?, label? }
```

## Features

- Parses standard unified diff format (`diff --git`, `---/+++`, `@@ ... @@` hunks)
- Detects new files, deleted files, binary files
- Side-by-side two-column layout with configurable terminal width (default 120)
- Line number gutters (4 chars, padded)
- ANSI color coding: green for additions, red for removals, dim for context
- Word-level intra-line highlighting via LCS (longest common subsequence)
- Zero external dependencies - pure TypeScript

## Usage

```ts
import { parseDiff, renderSideBySide } from "./packages/tools/diff-view.ts";

const raw = await Bun.file("my.patch").text();
const files = parseDiff(raw);
console.log(renderSideBySide(files, { width: 160, wordHighlight: true }));
```

## Constraints

- Does NOT modify any existing files in the repo
- Does NOT export from `packages/tools/index.ts` (quarantine means unwired)
- Terminal width must be >= 60 to avoid degenerate layouts
- Binary files are noted but not rendered (no content to show)

## Integration path (if promoted)

1. Add export to `packages/tools/index.ts`
2. Register as a tool in `packages/eight/tools.ts` (viewDiff tool)
3. Wire into TUI chat screen for inline patch review

## Why quarantine

New capability, not yet connected to anything. Needs evaluation of:
- Whether Ink/React rendering would be preferred over raw ANSI strings in the TUI
- Whether the LCS word-diff adds enough value vs complexity (~50 lines)
- Whether `parseDiff` output format is compatible with any future Git tool wrappers
