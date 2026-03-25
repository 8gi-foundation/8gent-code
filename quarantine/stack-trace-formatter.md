# stack-trace-formatter

**Status:** quarantine

## Description

Formats error stack traces for terminal display with ANSI syntax highlighting,
inline source context, and noise reduction.

Key behaviors:
- Colorized error type and message (bold red)
- App frames highlighted in yellow; node built-ins and node_modules dimmed
- Relative file paths relative to `process.cwd()`
- 2-line source context around the throw site (configurable)
- node_modules frames filtered by default with a hidden-frame count
- Configurable max frame depth (default 10)

## API

```ts
import { formatStack, formatError } from '../packages/tools/stack-trace-formatter'

// From a raw stack string
const output = formatStack(error.stack, { contextLines: 3, maxFrames: 8 })

// From an Error object (preferred)
console.log(formatError(new Error('boom')))
```

### `formatStack(stack: string, options?: FormatOptions): string`

| Option | Type | Default | Description |
|---|---|---|---|
| `contextLines` | `number` | `2` | Source lines above/below the error line |
| `filterNodeModules` | `boolean` | `true` | Hide node_modules frames |
| `cwd` | `string` | `process.cwd()` | Root for relative path display |
| `maxFrames` | `number` | `10` | Max stack frames shown |

### `formatError(error: Error | unknown, options?: FormatOptions): string`

Convenience wrapper - extracts `.stack` then calls `formatStack`.

## Integration Path

1. Wire into `packages/eight/agent.ts` error handler - replace raw `console.error(err.stack)` calls.
2. Expose via the TUI `ErrorBoundary` or debug panel so agent errors render with context.
3. Optionally surface in the debugger app (`apps/debugger/`) for post-session stack inspection.

## Files

- `packages/tools/stack-trace-formatter.ts` - implementation (~140 lines)
- `quarantine/stack-trace-formatter.md` - this file
