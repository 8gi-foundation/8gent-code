# json-stream-parser

**Tool name:** JSONStreamParser
**Package:** `packages/tools/json-stream-parser.ts`
**Status:** quarantine

## Description

Incremental streaming JSON parser that processes partial/streaming JSON text as chunks arrive and emits complete parsed values via callbacks. Designed for LLM streaming responses and any source that delivers JSON incrementally.

Key capabilities:
- Feed arbitrary chunks of JSON text via `feed(chunk)`
- Receive complete values via `onValue(callback)` as they are parsed
- Handles partial strings, numbers, booleans, null, objects, and arrays
- NDJSON (newline-delimited JSON) mode via `{ ndjson: true }` option
- Recoverable parse errors - malformed fragments are silently discarded, stream continues
- `flush()` to attempt parsing any trailing content after stream ends

## Usage

```typescript
import { JSONStreamParser } from "../packages/tools/json-stream-parser.ts";

// Standard streaming JSON
const parser = new JSONStreamParser();
parser.onValue((value) => console.log("got:", value));
parser.feed('{"key":');
parser.feed('"val');
parser.feed('ue"}');

// NDJSON mode
const nd = new JSONStreamParser({ ndjson: true });
nd.onValue((v) => console.log(v));
nd.feed('{"a":1}\n{"b":2}\n');
```

## Integration path

1. Wire into `packages/eight/tools.ts` as a utility available to the agent loop.
2. Use in the provider layer (`packages/providers/`) to parse LLM streaming response bodies without buffering the full response.
3. Potential use in `packages/memory/` to stream-ingest large JSON memory dumps without loading them fully into memory.
4. Can replace any ad-hoc `JSON.parse(fullResponse)` call where the source is a readable stream.
