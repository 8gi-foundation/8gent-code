# file-diff

## Tool Name
`file-diff`

## Description
Reads two files from disk and returns structured diff data: added, removed, and unchanged line counts plus a hunks array. Uses LCS (longest common subsequence) for accurate line-level diffing. Zero dependencies beyond `node:fs`. Missing files are handled gracefully via the `error` field rather than throwing.

## Exported API

| Export | Signature | Purpose |
|--------|-----------|---------|
| `fileDiff` | `(pathA: string, pathB: string) => Promise<FileDiffResult>` | Primary entry point - reads both files and returns diff |
| `FileDiffResult` | type | `{ added, removed, unchanged, hunks, error? }` |
| `DiffHunk` | type | `{ startLine: number, lines: string[] }` - lines prefixed with `+` or `-` |

### FileDiffResult shape

```ts
{
  added: number;      // count of lines only in pathB
  removed: number;    // count of lines only in pathA
  unchanged: number;  // count of lines common to both
  hunks: DiffHunk[];  // grouped change regions
  error?: string;     // set if either file could not be read
}
```

### DiffHunk shape

```ts
{
  startLine: number;  // 1-indexed line number in pathA where hunk begins
  lines: string[];    // e.g. ["-old line", "+new line"]
}
```

## Status
**quarantine** - isolated, not wired into the agent tool registry yet.

## Integration Candidates

- `packages/eight/tools.ts` - expose as an agent tool so Eight can diff files during code review or patch application
- `packages/validation/` - use in checkpoint-verify flow to show what changed between snapshots
- `apps/tui/src/` - render hunks in the TUI diff viewer using `DiffHunk[]` directly
- `packages/ast-index/` - pair with AST index to show structural vs textual diff side by side

## Promotion Criteria

1. Confirm LCS-based hunk output is accurate against known test cases (at least add/remove/mixed scenarios).
2. Add to `packages/eight/tools.ts` under a `file_diff` tool definition with path validation.
3. Wire a tool call handler so the agent can invoke it on any two paths.
4. Add a benchmark test in `benchmarks/categories/abilities/` covering missing-file error path.
5. Remove this file and update tool inventory once promoted.

## Notes
- Line-based only - no character-level diff within a line.
- LCS is O(m*n) - fine for source files, not suitable for very large binaries.
- `error` is set and counts are all zero when either file is unreadable; no exception is thrown.
- Distinct from `simple-diff` (string-in, set-based) - this is file-in, LCS-based with hunk grouping.
