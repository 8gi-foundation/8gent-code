# diff-apply

**Tool name:** diff-apply
**Status:** quarantine

## Description

Applies text diffs (add/remove line edits) to source strings. Supports three edit modes:

- **Line edits** - individual add/remove operations via `applyEdits()`
- **Hunks** - unified hunk-style multi-line replacements via `applyHunks()`
- **Revert** - undo a prior set of edits via `revertEdits()`

Includes a `validateEdits()` guard that pre-checks edits for out-of-bounds line numbers and missing content before applying.

## API

```ts
import {
  applyEdits,
  applyHunks,
  revertEdits,
  validateEdits,
  Edit,
  Hunk,
} from "../packages/tools/diff-apply.ts";
```

### `validateEdits(source, edits) -> ValidationResult`

Pre-flight check. Returns `{ valid: boolean, errors: string[] }`. Run before applying to avoid partial mutations.

### `applyEdits(source, edits) -> string`

Applies `Edit[]` in order. Line numbers refer to the live state after each prior edit.

### `applyHunks(source, hunks) -> string`

Applies `Hunk[]` in reverse-line order so offsets stay stable. Hunks must be non-overlapping.

### `revertEdits(source, edits) -> string`

Undoes a prior `applyEdits()` call by inverting each edit in reverse order.

## Integration path

1. Wire into `packages/eight/tools.ts` as a registered tool so Eight can patch files directly.
2. Surface via TUI diff-preview widget (planned).
3. Use in `packages/validation/` checkpoint-verify-revert loop for atomic patch application.

## Constraints

- Line numbers are 1-based throughout.
- `applyEdits` mutates incrementally - line numbers shift after each edit.
- `applyHunks` is offset-stable (applies in reverse).
- No external deps. Pure TypeScript/Bun.
