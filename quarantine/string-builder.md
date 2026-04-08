# Tool: string-builder

## Description

Efficient string concatenation with lazy evaluation. Collects string parts in
an array and joins only on `toString()`, avoiding the O(n^2) cost of repeated
string concatenation. Includes indentation management for code generation,
line-by-line building, and a `block()` helper for nested indented sections.

## Status

**quarantine** - reviewed and ready for integration. No external dependencies.
Self-contained in a single file. Unit tests not yet written.

## API

```ts
import { StringBuilder } from "../packages/tools/string-builder";

const sb = new StringBuilder();
sb.appendLine("function hello() {");
sb.block((b) => {
  b.appendLine('console.log("hello world");');
});
sb.appendLine("}");
console.log(sb.toString());
```

Key methods:

| Method | Description |
|--------|-------------|
| `append(value)` | Append raw string |
| `prepend(value)` | Prepend raw string |
| `appendLine(value?)` | Append with current indent + newline |
| `blankLine()` | Insert empty line |
| `indent()` / `dedent()` | Increase / decrease indent level |
| `block(fn)` | Run callback at +1 indent then restore |
| `setIndentString(str)` | Override indent unit (default: 2 spaces) |
| `clear()` | Reset all content and indent |
| `toString()` | Lazy join - cached until next mutation |
| `length` | Total character count |
| `partCount` | Number of parts (debug) |

Static helpers: `StringBuilder.fromLines(lines)`, `StringBuilder.withIndent(str)`.

## Integration Path

1. Wire into `packages/eight/tools.ts` as a utility available to the agent
   during code generation tasks.
2. Use inside `packages/orchestration/` when building shell scripts or
   multi-step command sequences as strings.
3. Consider as the default output accumulator in any package that currently
   uses `let output = ""; output += ...` patterns.

## Files

- `packages/tools/string-builder.ts` - implementation (130 lines)
