# ASCII Art Generator

## Tool Name

`ascii-art-generator`

## Description

Generates 5-line tall ASCII art text banners from input strings with optional Unicode box drawing borders. Useful for terminal branding, session headers, and TUI splash screens.

### Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `render` | `(text: string, options?: RenderOptions) => string[]` | Returns 5 rows of ASCII art for the input text |
| `box` | `(lines: string[], padding?: number) => string` | Wraps rendered lines in a Unicode box-drawing border |
| `banner` | `(text: string, options?) => string` | Convenience: render + box in one call |

### Supported Characters

- A-Z (case-insensitive)
- 0-9
- Basic punctuation: `! . , ? - _ : space`

### Example Output

```
+-------------------------------+
|                               |
|  ####   ####  ###### #    #  |
|  #   # #    # #      ##   #  |
|  ####  #    # ####   # #  #  |
|  #   # #    # #      #  # #  |
|  #   #  ####  ###### #   ##  |
|                               |
+-------------------------------+
```

## Status

**quarantine** - standalone, no dependencies, not wired into the agent tool registry.

## Integration Path

1. Register in `packages/eight/tools.ts` as a built-in tool (`ascii_art`).
2. Add to the TUI splash screen (`apps/tui/src/screens/`) for session header branding.
3. Optionally expose as `/banner <text>` slash command in the agent CLI.
4. Acceptance criteria: renders all A-Z + 0-9 correctly, box drawing aligned on standard monospace terminal.
