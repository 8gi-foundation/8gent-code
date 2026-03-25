# Quarantine: json-lines

**Status:** Candidate
**File:** `packages/tools/json-lines.ts`
**Lines:** ~110

## What it does

Provides streaming, low-memory JSON Lines (JSONL) file operations built on Node.js core APIs. No external dependencies.

| Export | Signature | Description |
|--------|-----------|-------------|
| `readLines` | `(path) => AsyncGenerator<T>` | Streams parsed objects line by line, skips blank/malformed |
| `writeLines` | `(path, items[]) => Promise<void>` | Overwrites file with array of items, one per line |
| `appendLine` | `(path, item) => Promise<void>` | Appends a single item; creates file if absent |
| `countLines` | `(path) => Promise<number>` | Counts valid JSON lines |
| `tailLines` | `(path, n) => Promise<T[]>` | Returns last n valid lines as objects |
| `filterLines` | `(path, predicate) => AsyncGenerator<T>` | Streams only lines matching predicate |
| `fileSize` | `(path) => Promise<number>` | Byte size of file, 0 if missing |

## Why quarantine

- Covers the same ground as `ndjson-stream.md` (already in quarantine) - needs deduplication decision before promotion.
- `filterLines` and `tailLines` add value the ndjson-stream candidate lacks.
- No tests yet.

## Promotion criteria

- [ ] Decide fate of `ndjson-stream.md` (merge, replace, or keep both)
- [ ] Add unit tests covering all exports
- [ ] Wire into `packages/tools/index.ts`
