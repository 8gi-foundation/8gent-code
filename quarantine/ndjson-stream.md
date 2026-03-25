# ndjson-stream

## Tool Name
`ndjson-stream`

## Description
Reads and writes newline-delimited JSON (NDJSON) streams. Provides async generators
for memory-safe streaming of large files, a synchronous stringifier for in-memory
collections, and a single-line append helper for log-style writes.

Exposed API:
- `parseNDJSON(input)` - async generator over a string, Buffer, or Readable stream
- `stringifyNDJSON(items)` - serialize any iterable/async-iterable to NDJSON string
- `readNDJSONFile(path)` - async generator that streams an NDJSON file from disk
- `writeNDJSONFile(path, items)` - write iterable to file (overwrites)
- `appendNDJSON(path, item)` - append one object as a single NDJSON line

## Status
**quarantine** - self-contained, no external deps, not yet wired into agent tools index.

## Integration Path
1. Export from `packages/tools/index.ts` once reviewed.
2. Register as an agent tool in `packages/eight/tools.ts` with a `read_ndjson` /
   `write_ndjson` / `append_ndjson` surface.
3. Use in `packages/memory/` for append-only episodic log files (replaces raw JSON blobs).
4. Use in `packages/kernel/` training pair collection (`personal-collector.ts`) - already
   writes line-delimited records; this tool standardizes the format.

## Location
`packages/tools/ndjson-stream.ts`
