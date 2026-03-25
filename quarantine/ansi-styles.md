# Quarantine: ansi-styles

## What

Raw ANSI escape code open/close pairs for terminal styling. Covers all standard text modifiers, 16 named foreground/background colors, 256-color indexed palette, and 24-bit RGB. Designed for environments that need low-level control over escape sequences - color loggers, TUI renderers, custom formatters - without pulling in a full terminal library.

## File

`packages/tools/ansi-styles.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { styles, apply, applyAll } from './packages/tools/ansi-styles';

// Text modifiers
apply('hello', styles.bold)
apply('hello', styles.dim)
apply('hello', styles.italic)
apply('hello', styles.underline)
apply('hello', styles.inverse)
apply('hello', styles.strikethrough)

// Named colors (foreground)
apply('hello', styles.fg.red)
apply('hello', styles.fg.cyan)
apply('hello', styles.fg.greenBright)

// Named colors (background)
apply('hello', styles.bg.blue)
apply('hello', styles.bg.yellowBright)

// 256-color palette (0-255)
apply('hello', styles.color256(214))    // orange
apply('hello', styles.bgColor256(17))  // dark blue bg

// 24-bit RGB
apply('hello', styles.rgb(255, 128, 0))       // orange fg
apply('hello', styles.bgRgb(30, 30, 30))      // near-black bg

// Stack multiple styles (outermost first)
applyAll('hello', styles.bold, styles.fg.cyan)

// Reset all
apply('hello', styles.reset)
```

## Pairs Format

Every style is an `{ open: string, close: string }` pair - open applies the style, close removes only that style (not a full reset). This keeps nested styles safe.

```ts
styles.bold   // { open: '\x1b[1m', close: '\x1b[22m' }
styles.fg.red // { open: '\x1b[31m', close: '\x1b[39m' }
```

## Promotion Criteria

- Unit tests covering apply/applyAll and at least 3 style categories
- Verified no bleeding between nested styles
- Wired into `packages/tools/index.ts` exports
