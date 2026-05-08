# Quarantine: line-reader

**Package:** `packages/tools/line-reader.ts`
**Status:** Quarantine - review before wiring into index

---

## What it does

Efficient line-by-line file reading without loading entire files into memory.
Useful for log parsing, large source file analysis, and streaming grep operations.

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `readLines(path)` | `AsyncGenerator<string>` | Stream file line-by-line via readline |
| `readLinesSync(path)` | `Generator<string>` | Sync generator, reads full file once |
| `countLines(path)` | `Promise<number>` | Count total lines via streaming |
| `headLines(path, n)` | `Promise<string[]>` | First N lines, stops early |
| `tailLines(path, n)` | `Promise<string[]>` | Last N lines via circular buffer |
| `grepLines(path, pattern)` | `Promise<GrepMatch[]>` | Matching lines with 1-based line numbers |

## Memory characteristics

- `readLines` / `countLines` / `headLines` / `tailLines` / `grepLines` - O(chunk) memory via createReadStream
- `readLinesSync` - O(file) memory, loads full file; for small-to-medium files only
- `tailLines` - O(n) circular buffer regardless of file size

## Usage

```ts
import { readLines, headLines, tailLines, grepLines, countLines } from "./packages/tools/line-reader.ts";

for await (const line of readLines("/var/log/app.log")) { process(line); }

const header = await headLines("./src/agent.ts", 20);
const recent = await tailLines("/var/log/app.log", 50);
const todos  = await grepLines("./src/agent.ts", /TODO/i);
const n      = await countLines("./large-dataset.jsonl");
```

## Promotion checklist

- [ ] Wire into `packages/tools/index.ts`
- [ ] Add tests in `packages/tools/line-reader.test.ts`
- [ ] Benchmark against readFileSync().split("\n") on 100MB file
- [ ] Confirm Bun readline compat matches Node behavior
