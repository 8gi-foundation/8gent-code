# keybinding-parser

**Tool name:** keybinding-parser
**Package path:** `packages/tools/keybinding-parser.ts`
**Status:** quarantine

## Description

Parses keyboard shortcut strings (e.g. `ctrl+shift+a`) into structured `KeyBinding` objects. Supports cross-platform normalization (cmd vs ctrl on macOS) and event matching against browser or terminal key events.

## Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `parse` | `(shortcut: string) => KeyBinding` | Parse a shortcut string into a structured binding |
| `matches` | `(event: KeyEvent, binding: KeyBinding) => boolean` | Check if a key event matches a binding |
| `format` | `(binding: KeyBinding) => string` | Format a binding to a human-readable string |
| `normalize` | `(binding: KeyBinding, platform?) => KeyBinding` | Remap ctrl to meta on macOS |

## KeyBinding shape

```ts
{
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string; // lowercased, aliased (e.g. "esc" -> "escape")
}
```

## Integration path

1. Wire into `apps/tui/src/hooks/useHotkeys.ts` to replace any raw string comparisons with `parse` + `matches`.
2. Expose in `packages/eight/tools.ts` as a utility for agents that register hotkeys.
3. Use `normalize` at the TUI bootstrap layer to detect platform and remap bindings once at startup.
4. Optionally expose `format` in the TUI keybinding help panel to render human-friendly shortcut labels.

## Why quarantine

No existing caller yet. Needs a concrete integration PR to graduate from quarantine. The tool is self-contained and has no dependencies outside the TypeScript standard library.
