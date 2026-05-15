# Quarantine: streaming-json

**Status:** Quarantine - not yet wired into production paths
**File:** `packages/tools/streaming-json.ts`
**Branch:** `quarantine/streaming-json`

---

## What It Does

`StreamingJsonParser` is a zero-dependency class for parsing partial or
malformed JSON emitted by LLM streams. It handles the three most common failure
modes from streamed model output:

| Problem | Handling |
|---------|----------|
| Trailing commas (`{"a":1,}`) | Stripped before parse |
| Truncated objects/arrays | Synthetic closers appended |
| Truncated strings | String closed, then containers closed |
| NDJSON (one object per line) | Line-boundary accumulation, emit on newline |

---

## API Summary

```ts
import { StreamingJsonParser, parseRepaired, parseNdjson } from "./packages/tools/streaming-json.ts";

// Single-value mode (default)
const parser = new StreamingJsonParser();
parser.feed('{"name": "eight", "score":');
parser.feed(' 42}');
const result = parser.flush(); // { ok: true, value: { name: "eight", score: 42 } }

// Truncated JSON
const p2 = new StreamingJsonParser();
p2.feed('{"items": ["alpha", "beta", "gam');
const r2 = p2.flush(); // { ok: true, value: { items: ["alpha", "beta", "gam"] } }

// NDJSON mode
const ndp = new StreamingJsonParser({ ndjson: true });
ndp.feed('{"role":"user","text":"hello"}\n{"role":"assistant","text":"hi"}\n');
const values = ndp.take(); // [ { role: "user", ... }, { role: "assistant", ... } ]

// One-shot convenience
const fixed = parseRepaired('{"a":1,"b":2,}'); // { ok: true, value: { a: 1, b: 2 } }
const rows  = parseNdjson('{"id":1}\n{"id":2}\n'); // [{ id: 1 }, { id: 2 }]
```

---

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ndjson` | `boolean` | `false` | Enable NDJSON line-by-line mode |
| `maxBuffer` | `number` | `1_000_000` | Char limit before throwing |

---

## Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `feed(chunk)` | `void` | Append a new chunk to the buffer |
| `flush()` | `ParseResult` | Best-effort parse of current buffer. Does not consume. |
| `take()` | `T[]` | Drain completed values (NDJSON) or parse full buffer (single mode) |
| `end()` | `ParseResult` | flush() + clear buffer |
| `reset()` | `void` | Clear all state for reuse |
| `rawBuffer` | `string` | Inspect the current buffer |

---

## Repair Pipeline

Three stages, attempted in order:

1. **Raw parse** - `JSON.parse(input)` as-is
2. **Trailing comma strip** - regex `/,(\s*[}\]])/g` then re-parse
3. **Truncation recovery** - walk the string tracking open brackets/braces/strings,
   append synthetic closers, re-parse

If all three fail, `flush()` returns `{ ok: false, error: "..." }`.

---

## Known Limitations

- Does not repair mismatched bracket types (e.g. `[}`)
- Does not recover from mid-key truncation (e.g. `{"ke`)
- NDJSON mode silently drops lines that fail all three repair stages

---

## Promotion Checklist

Before removing from quarantine and wiring into production:

- [ ] Add unit tests covering all three repair stages
- [ ] Benchmark throughput on 10MB NDJSON streams
- [ ] Wire into `packages/eight/agent.ts` tool-call JSON extractor
- [ ] Wire into `packages/providers/` streaming response parsers
- [ ] Export from `packages/tools/index.ts`
- [ ] Add entry to `CHANGELOG.md`
