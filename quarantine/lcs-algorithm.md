# lcs-algorithm

## Description

Longest Common Subsequence (LCS) algorithm for diff computation, merge operations, and edit script generation. Operates on generic arrays or line-split strings.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `lcs` | `<T>(a: T[], b: T[]) => T[]` | Full LCS reconstruction |
| `lcsLength` | `<T>(a: T[], b: T[]) => number` | LCS length only (no allocation) |
| `lcsLines` | `(textA: string, textB: string) => string[]` | Line-level LCS on multi-line text |
| `editScript` | `(textA: string, textB: string) => EditOp[]` | keep/insert/delete edit script |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/validation/` merge logic when reverting checkpoints with partial preservations.
3. Use in the diff renderer of the TUI activity monitor to highlight changed lines.
4. Expose as an agent tool so Eight can describe file diffs in natural language before applying them.

## Source

`packages/tools/lcs-algorithm.ts` - 120 lines, zero dependencies, pure TypeScript.
