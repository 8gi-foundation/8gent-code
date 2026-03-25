# Quarantine: diff-viz

## What

Terminal diff visualizer - takes unified git diff output and renders it with ANSI colors, line numbers, and file headers.

## File

`packages/tools/diff-visualizer.ts` (~110 lines)

## API

- `visualizeDiff(diff: string, options?)` - pure function, renders a diff string to colored terminal output
- `visualizeDiffFromGit(cwd: string, staged?)` - runs `git diff` and visualizes the result (Bun subprocess)

## Features

- File headers in bold cyan
- Hunk headers with line number context (dim)
- Additions in green, deletions in red
- Optional line number gutter (on by default)
- Trailing whitespace highlighting in additions (red background)
- Zero dependencies - uses raw ANSI escape codes

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `lineNumbers` | `true` | Show old/new line numbers in gutter |
| `highlightWhitespace` | `true` | Flag trailing whitespace in additions |

## Status

Quarantined - needs integration testing with TUI and agent tool registry before promotion.

## Promotion criteria

1. Unit tests covering add/del/context/hunk-header/empty diff
2. Integration with `packages/tools/index.ts` tool registry
3. Confirmed rendering in Ink TUI context (raw ANSI vs Ink Text)
