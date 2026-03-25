# diff-printer

**Tool name:** printDiff
**Status:** quarantine
**File:** `packages/tools/diff-printer.ts`

## Description

A terminal-friendly unified diff printer. Takes two strings, computes added/removed/context lines via LCS, and returns an ANSI-colored string ready to write to stdout. Green for added lines, red for removed, cyan for hunk headers.

Zero external dependencies. Self-contained in one file under 100 lines.

## API

```ts
import { printDiff } from "./packages/tools/diff-printer.ts";

// Basic usage
const result = printDiff(original, modified);
console.log(result);

// Custom context window (default: 3)
const tight = printDiff(a, b, { context: 1 });

// Custom file labels in the header
const labeled = printDiff(a, b, { labelA: "before.ts", labelB: "after.ts" });

// Identical strings return empty string - safe to check before printing
const out = printDiff(a, b);
if (out) console.log(out);
```

### Signature

```ts
function printDiff(
  a: string,
  b: string,
  options?: {
    context?: number;  // lines of context around each hunk, default 3
    labelA?:  string;  // header label for "before", default "a"
    labelB?:  string;  // header label for "after",  default "b"
  }
): string
```

Returns an empty string when `a === b`.

## Integration candidates

| Consumer | Usage |
|----------|-------|
| `packages/validation/` | Show before/after when a healing checkpoint reverts a file |
| `packages/eight/agent.ts` | Display a patch preview before applying tool results |
| `apps/tui/src/screens/` | Render file diffs inline in the chat view |
| `packages/self-autonomy/` | Surface persona/prompt mutations as readable diffs |
| `packages/tools/file-diff.ts` | Can delegate its string-level rendering to `printDiff` |

## Promotion criteria

- [ ] At least one real consumer wired up (validation, TUI, or agent loop)
- [ ] TTY detection - strip ANSI when stdout is not a TTY (pipe, CI)
- [ ] Tested on multi-hunk diffs (renames, large refactors) with no phantom hunks
- [ ] Edge cases verified: empty strings, single-line inputs, identical inputs
- [ ] Option to emit plain unified diff (no ANSI) for file output or programmatic use
