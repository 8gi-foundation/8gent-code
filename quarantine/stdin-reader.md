# stdin-reader

**Tool name:** stdin-reader
**Description:** Reads piped stdin input with automatic format detection and streaming line-by-line processing. Detects JSON, NDJSON (newline-delimited JSON), CSV, and plain text. Parses accordingly and returns a typed result. Also detects whether the process is attached to an interactive TTY so callers can bail early when no pipe is present.

**Status:** quarantine
**Location:** `packages/tools/stdin-reader.ts`

## Exports

- `readStdin(options?)` - reads all stdin, detects format, parses, returns `StdinResult`
- `detectFormat(input)` - classify a raw string as `"json" | "csv" | "ndjson" | "text"`
- `isInteractive()` - returns `true` if stdin is a TTY (no pipe)
- `StdinResult` - typed result: `{ format, raw, lines, parsed }`
- `StdinOptions` - `{ maxBytes?, encoding?, rawOnly? }`

## Integration path

1. Wire into `packages/tools/index.ts` as a named export
2. Expose as an agent tool in `packages/eight/tools.ts` so the agent can consume piped data (e.g. `cat data.json | 8gent ask "summarise this"`)
3. Use in `apps/tui/` and `apps/clui/` entry points to detect piped input at startup and pre-load it into the first message
4. Feed detected format into `packages/self-autonomy/reflection.ts` so the agent can adapt its processing strategy

## Usage

```ts
import { readStdin, detectFormat, isInteractive } from "./stdin-reader";

if (isInteractive()) {
  console.error("Pipe some data in first.");
  process.exit(1);
}

const result = await readStdin();
console.log(result.format);  // "json" | "csv" | "ndjson" | "text"
console.log(result.parsed);  // parsed object, array of objects, array of JSON, or raw string
```
