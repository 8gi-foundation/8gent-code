# escape-sequences

**Status:** quarantine

## Description

Terminal escape sequence generator. Produces ANSI/VT100/xterm control strings for cursor control, screen manipulation, scroll regions, style (SGR), and mouse tracking. Zero runtime dependencies - pure string construction.

## Exports

| Object | Methods |
|--------|---------|
| `cursor` | up, down, left, right, position, column, lineUp, lineDown, save, restore, hide, show, report, blockSteady, underlineSteady, barSteady |
| `screen` | clear, clearToEnd, clearToStart, clearAll, clearLine, clearLineToEnd, clearLineToStart, altEnter, altExit, scrollRegion, scrollRegionReset, scrollUp, scrollDown, insertLines, deleteLines, title |
| `style` | reset, bold, dim, italic, underline, blink, inverse, hidden, strikethrough, fg16, bg16, fg256, bg256, fgRgb, bgRgb, wrap |
| `mouse` | enableX10, enableNormal, enableButtonEvent, enableAllMotion, disable, enableSgr, disableSgr |

## Integration path

- `apps/tui/` - replace any raw escape string literals with calls from this module
- `packages/tools/cursor-position.ts` - complement: reads cursor position, this module sets it
- `packages/eight/tools.ts` - register as a built-in tool if agents need direct terminal control
- Any package that writes to stdout and needs cursor/screen management

## Usage

```typescript
import { cursor, screen, style, mouse } from "./packages/tools/escape-sequences";

process.stdout.write(cursor.hide());
process.stdout.write(screen.altEnter());
process.stdout.write(cursor.position(1, 1));
process.stdout.write(style.wrap(style.fgRgb(232, 97, 10), "8gent"));
process.stdout.write(screen.altExit());
process.stdout.write(cursor.show());
```
