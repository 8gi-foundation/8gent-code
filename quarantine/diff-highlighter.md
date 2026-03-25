# diff-highlighter

## Tool Name
`diff-highlighter`

## Description
Syntax-highlights unified diffs with ANSI escape codes for terminal display. Parses standard unified diff output and applies per-line coloring: additions in green, deletions in red, hunk headers in cyan, file headers in bold cyan, and context lines dimmed. Also performs word-level LCS diffing on paired removal/addition lines, highlighting the exact changed tokens with background colors (bg-green for added words, bg-red for removed words).

## Status
**quarantine** - standalone, no side effects, no external dependencies.

## API
```typescript
import { highlightDiff } from "./packages/tools/diff-highlighter.ts";

const colored = highlightDiff(rawUnifiedDiff);
process.stdout.write(colored);
```

### Export
- `highlightDiff(diff: string): string` - takes a unified diff string, returns an ANSI-colored string ready for terminal output.

## Integration Path
1. **Agent tool** - wire into `packages/tools/index.ts` as `diff_highlight`. Useful when the agent displays file changes in the TUI chat view.
2. **TUI diff view** - `apps/tui/src/components/` could use this to render git diffs inline within conversations, complementing the existing `packages/tools/diff-view.ts`.
3. **Debugger panel** - `apps/debugger/` could call this when showing patch previews before applying edits.

## Files
- `packages/tools/diff-highlighter.ts` - implementation (~145 lines)

## Dependencies
None. Pure TypeScript, uses only ANSI escape sequences.

## Size
~145 lines. Self-contained. Safe to delete with zero blast radius.
