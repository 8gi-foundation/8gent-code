# output-formatter

**Status:** Quarantine
**Package:** `packages/tools/output-formatter.ts`
**Lines:** ~130

## What It Does

Formats arbitrary data for different output targets: terminal, JSON, markdown, and CSV. Auto-detects TTY to choose a sensible default mode (terminal when interactive, JSON when piped).

## API

```ts
import { Formatter, format, terminal, json, markdown, csv } from "./packages/tools/output-formatter.ts";

// One-shot with auto-detected mode
format({ name: "Eight", version: "1.0.0" });

// Explicit mode
format([{ id: 1, status: "ok" }], "markdown");
format([{ id: 1, status: "ok" }], "csv");

// Class with pinned mode
const f = new Formatter("terminal");
f.format(data);
```

## Output Modes

| Mode | When to use |
| --- | --- |
| `terminal` | Human-readable, aligned columns, TTY default |
| `json` | Machine-readable, pretty-printed, pipe default |
| `markdown` | GitHub/docs tables |
| `csv` | Spreadsheet export, data pipelines |

## Auto-detection

`Formatter` calls `process.stdout.isTTY`. TTY = `terminal` default. Non-TTY (pipe, file redirect) = `json` default. Override by passing `mode` explicitly.

## Types Handled

- Primitives (`string`, `number`, `boolean`, `null`) - rendered as-is
- Single object - key/value pairs or single-row table
- Array of objects - multi-row table
- Array of primitives - indexed table

## Notes

- CSV fields with commas, quotes, or newlines are RFC 4180 escaped
- Terminal tables auto-pad columns to align
- No external dependencies
