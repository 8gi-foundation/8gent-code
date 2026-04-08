# patch-applier

**Status:** quarantine

## Description

Applies unified diff patches to source file text programmatically. Parses standard unified diff format (`--- / +++ / @@ hunks`), matches context lines with fuzzy offset tolerance (+/-3 lines), applies removals and additions in hunk order, and reports conflicts when context cannot be located.

Exports a single `applyPatch(source, patch)` function that returns a `PatchResult` with:
- `success` - true if all hunks applied cleanly
- `output` - the patched source string
- `conflicts` - list of hunk descriptions that could not be applied
- `hunksApplied` / `hunksSkipped` - counts

## Location

`packages/tools/patch-applier.ts`

## Integration Path

1. Wire into `packages/tools/index.ts` exports once validated.
2. Use inside the agent tool loop (`packages/eight/tools.ts`) as an `apply_patch` tool - accepts a file path + diff string, reads the file, applies, writes back.
3. Pair with `diff-view.ts` for a full diff-preview-then-apply workflow.
4. Consider exposing as a CLI command: `8gent patch <file> <diff-file>`.

## What It Does NOT Do

- Binary patches (plain text only)
- Multi-file diffs (one file at a time)
- Three-way merge conflict markers
- Git-extended diff headers (`index`, `mode`, `similarity`)
