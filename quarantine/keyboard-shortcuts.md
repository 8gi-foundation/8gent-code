# Quarantine: Keyboard Shortcuts

**Status:** quarantined - not wired into TUI yet
**File:** `packages/tools/keyboard-shortcuts.ts`
**Lines:** ~120

## What it does

Centralised registry of keyboard shortcuts for the 8gent TUI. Provides:

- A typed `Shortcut` definition (key combo, description, context, locked flag)
- A static registry of default shortcuts
- Helper functions: `findShortcut`, `shortcutsByContext`, `matchesShortcut`, `formatHelpTable`

## Registered shortcuts

| Combo   | ID              | Description                              | Context  |
|---------|-----------------|------------------------------------------|----------|
| Ctrl+C  | abort           | Abort current generation                 | global   |
| Ctrl+D  | exit            | Exit the TUI                             | global   |
| Ctrl+L  | clear           | Clear the screen                         | global   |
| Tab     | autocomplete    | Trigger autocomplete / accept suggestion | chat, editor |
| Up      | history-prev    | Previous item in history                 | chat     |
| Down    | history-next    | Next item in history                     | chat     |
| Ctrl+S  | save-checkpoint | Save a session checkpoint                | global   |

## Integration path

1. Import `matchesShortcut` in the TUI's `useInput` handler
2. Use `shortcutsByContext` to render a help overlay (Ctrl+? or similar)
3. Wire each shortcut id to its existing action (abort calls `agent.abort()`, etc.)

## Why quarantined

Registry only - no existing files were modified. Needs TUI integration before it does anything.
