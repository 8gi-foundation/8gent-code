# cursor-position

**Status:** quarantine

## Description

Tracks cursor position in a text buffer with bidirectional line/column-to-offset mapping. Handles tab-expanded visual columns, raw character columns, and context extraction (N lines surrounding the cursor).

Useful for code editing features, inline diff display, and any agent tool that needs to reason about where in a file a change is happening.

## Exports

- `CursorPosition` - stateful class wrapping a text buffer and cursor offset
- `offsetToLineCol(text, offset, tabWidth?)` - converts a character offset to `{ line, col, rawCol }`
- `lineColToOffset(text, line, col)` - converts a line/col pair back to a character offset

## Integration Path

1. Wire into `packages/eight/tools.ts` as a read-only tool: `cursor_position` - accepts `{ text, offset }`, returns `{ line, col, rawCol, context }`.
2. Use inside the inline-diff or file-edit flows to annotate error locations with human-readable line/col instead of raw offsets.
3. Expose via the TUI activity monitor to show "editing line X, col Y" during agent file edits.

## Location

`packages/tools/cursor-position.ts`

## Notes

- Tab width defaults to 4, configurable per call.
- All line/col values are 0-based.
- Offset is clamped to `[0, text.length]` - no out-of-bounds panics.
