# simple-diff

## Tool Name
`simple-diff`

## Description
Ultra-simple line diff for quick comparisons. Splits two strings on newlines and returns categorized lines: added, removed, unchanged. Includes colored terminal output via ANSI codes. No external dependencies.

## Exported API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `simpleDiff` | `(a: string, b: string) => DiffResult` | Core diff - returns added/removed/unchanged arrays |
| `orderedDiff` | `(a: string, b: string) => DiffLine[]` | Ordered diff preserving line sequence |
| `hasDifferences` | `(a: string, b: string) => boolean` | Quick check for any difference |
| `formatDiff` | `(diff: DiffResult) => string` | Colored terminal string from DiffResult |
| `formatOrderedDiff` | `(lines: DiffLine[]) => string` | Colored terminal string from ordered diff |
| `diffStats` | `(diff: DiffResult) => string` | Summary stats e.g. `+3 -1 =12` |

## Status
**quarantine** - isolated, not wired into the agent tool registry yet.

## Integration Path

1. Review and confirm the API surface is sufficient for agent use cases.
2. Add to `packages/eight/tools.ts` under a `diff` tool definition.
3. Wire the tool call handler so the agent can invoke `simpleDiff` on file contents or arbitrary strings.
4. Add a test in `benchmarks/categories/abilities/` to verify diff correctness.
5. Graduate from quarantine - remove this file and update tool inventory.

## Notes
- Line-based only. No character-level diff (use a dedicated lib if needed).
- Set-based comparison: duplicate lines across both inputs are treated as unchanged.
- ANSI codes work in any modern terminal. Strip with a regex if plain text is needed.
