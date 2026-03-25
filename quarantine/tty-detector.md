# Quarantine: tty-detector

## What

Runtime terminal capability detector. Inspects process environment variables and stdout properties to determine what the current terminal supports - color depth, Unicode, hyperlinks, CI context, and terminal identity. Zero dependencies.

## File

`packages/tools/tty-detector.ts` (~130 lines)

## Status

**quarantine** - new file, untested across terminal matrix, not yet wired into tool registry.

## API

```ts
import {
  isTTY,
  colorLevel,
  terminalWidth,
  terminalHeight,
  supportsHyperlinks,
  supportsUnicode,
  isCI,
  isDumb,
  terminalType,
} from "./packages/tools/tty-detector";

isTTY();              // boolean - is stdout an interactive TTY
colorLevel();         // 0 | 1 | 2 | 3 - no color / basic / 256 / truecolor
terminalWidth();      // number - columns, fallback 80
terminalHeight();     // number - rows, fallback 24
supportsHyperlinks(); // boolean - OSC 8 hyperlink support (heuristic)
supportsUnicode();    // boolean - UTF-8 / Unicode rendering
isCI();               // boolean - known CI environment
isDumb();             // boolean - TERM=dumb
terminalType();       // "iterm2" | "vscode" | "hyper" | "windows-terminal" | "xterm" | "screen" | "tmux" | "unknown"
```

## Why Quarantine

- Color level detection is heuristic - no universal terminal query API exists
- Hyperlink support has no reliable runtime probe - environment variable inference only
- Unicode detection uses locale heuristics that may miss edge cases
- Needs integration tests across: iTerm2, VS Code terminal, tmux, CI (GitHub Actions), dumb terminal

## Graduation Criteria

- [ ] Tested in CI (GitHub Actions) - `isCI()` returns true, `colorLevel()` returns 1
- [ ] Tested in VS Code integrated terminal - `terminalType()` returns `"vscode"`
- [ ] Tested with `TERM=dumb` - `isDumb()` true, `colorLevel()` returns 0
- [ ] Used by at least one package (TUI theme loader, music player, etc.)
- [ ] Wired into `packages/tools/index.ts`
