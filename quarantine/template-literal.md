# template-literal

**Status:** Quarantine - awaiting integration review

## What it does

Safe tagged template literals with auto-escaping and formatting utilities.
Five exported tag functions covering the most common string-shaping needs.

| Export | Behaviour |
|--------|-----------|
| `dedent` | Remove common leading indentation; strips opening/closing blank lines |
| `stripIndent` | Fully left-trim every line; collapses relative indentation |
| `oneLine` | Collapse all whitespace and newlines into a single space-joined line |
| `raw` | Preserve raw backslash escapes (like `String.raw`), interpolations still evaluated |
| `highlight` | Wrap each interpolated value in ANSI cyan; static parts unstyled |

## Usage

```ts
import { dedent, highlight, oneLine, raw, stripIndent } from "../packages/tools/template-literal";

// dedent - indent a block cleanly inside indented code
const msg = dedent`
  Error: model not found
    Check your Ollama instance is running
    and the model name is correct.
`;
// -> "Error: model not found\n  Check your Ollama instance is running\n  and the model name is correct."

// stripIndent - full left-trim, no relative indent preserved
const flat = stripIndent`
  line one
    line two
`;
// -> "line one\nline two"

// oneLine - SQL, long error messages
const query = oneLine`
  SELECT id, name
  FROM sessions
  WHERE active = true
`;
// -> "SELECT id, name FROM sessions WHERE active = true"

// raw - Windows paths, regex strings
const path = raw`C:\Users\eight\config.json`;
// -> "C:\\Users\\eight\\config.json"

// highlight - terminal log with colored interpolations
console.log(highlight`Loading ${modelName} on port ${port}`);
// -> "Loading \x1b[36mmistral\x1b[0m on port \x1b[36m11434\x1b[0m"
```

## File

`packages/tools/template-literal.ts` - 145 lines, zero dependencies.

## Integration candidates

- `packages/eight/prompts/system-prompt.ts` - use `dedent` for multiline prompt blocks
- `packages/tools/stack-trace-formatter.ts` - use `oneLine` for collapsed error messages
- Any TUI log output showing model names, paths, or ports - use `highlight`
- Shell command construction anywhere in `packages/` - use `raw` for path safety
