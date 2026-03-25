# Quarantine: Syntax Highlighter

## Status

Quarantined - not wired into TUI chat display or code block rendering yet.

## What it does

ANSI syntax highlighter for terminal code display. Tokenizes source code and applies ANSI escape codes per token type for readable output in any terminal.

Supported languages:
- **TypeScript / JavaScript** (`.ts`, `.tsx`, `.js`, `.jsx`) - full keyword set including async/await, type, interface, enum
- **Python** (`.py`) - all keywords, triple-quoted strings, hash comments
- **JSON** - strings, numbers, punctuation (no comment support per spec)

Token types colored:
- **keyword** - blue (language keywords)
- **string** - green (single, double, backtick, triple-quoted)
- **number** - yellow (int, float, hex, binary, octal)
- **comment** - dim (line `//`, block `/* */`, Python `#`)
- **operator** - cyan (`+`, `-`, `*`, `=`, `!`, etc.)
- **builtin** - magenta (JS built-ins: `console`, `Math`, `Promise`, etc.)
- **identifier** - default fg (variables, function names)
- **punctuation** - default fg (braces, brackets, semicolons)

## API

```ts
import { highlight } from "./packages/tools/syntax-highlighter";

const colored = highlight(code, "ts");   // TypeScript
const colored = highlight(code, "py");   // Python
const colored = highlight(code, "json"); // JSON
```

## Integration Path

1. **TUI chat screen** - wrap code blocks in `highlight()` before rendering with Ink. Detect language from fenced code block tag.
2. **Agent tool output** - when Eight runs `read_file` or `write_file` on code, optionally highlight the preview shown to the user.
3. **Debugger app** - syntax-color stack traces and code context lines in `apps/debugger/`.
4. **No external deps** - pure ANSI, no `chalk`, no `prism`, zero install overhead.

## File

`packages/tools/syntax-highlighter.ts` (~130 lines, self-contained)
