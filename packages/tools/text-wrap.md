# text-wrap

**Tool:** `packages/tools/text-wrap.ts`
**Status:** quarantine

## Description

Wraps text to a specified column width respecting word boundaries. Supports indent, hanging indent, newline preservation, and line trimming. Includes an ANSI-aware variant that treats escape sequences as zero-width so colored terminal output wraps at the correct visible column.

## Exports

| Function | Purpose |
|----------|---------|
| `wrap(text, width?, opts?)` | Full-featured word wrap with indent, hangingIndent, preserveNewlines, trimLines |
| `wrapWords(text, width?)` | Convenience alias - plain word wrap, no options |
| `wrapAnsi(text, width?)` | ANSI-aware wrap - measures visible width, preserves color codes |

### `WrapOptions`

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `indent` | `string` | `""` | Prefix for every line |
| `hangingIndent` | `string` | `indent` | Prefix for continuation lines (overrides `indent`) |
| `preserveNewlines` | `boolean` | `false` | Treat existing `\n` as hard breaks |
| `trimLines` | `boolean` | `true` | Strip trailing whitespace from each output line |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `apps/tui/` wherever terminal output needs column-constrained wrapping (help text, chat bubbles, status messages).
3. Use `wrapAnsi` in any component that renders ANSI-colored text to the terminal to prevent escape sequences from inflating the measured line length.
4. Use `wrap` with `indent`/`hangingIndent` for formatted CLI output (e.g. `--help` usage blocks, key-value lists).

## Notes

- `wrapAnsi` uses `\x1b\[[0-9;]*m` to detect CSI SGR sequences. Non-SGR sequences (cursor movement, etc.) are not stripped and will inflate the measured width - avoid mixing layout escapes into wrapped text.
- A word longer than `width` will never be broken mid-word; it occupies its own line.
- `preserveNewlines: true` splits the input on `\n` first, then wraps each segment independently, so blank lines in the source are preserved as blank lines in the output.
