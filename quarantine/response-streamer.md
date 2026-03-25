# response-streamer

## Tool Name
`ResponseStreamer`

## Description
Streams LLM responses with token-by-token processing. Buffers incoming tokens,
detects sentence boundaries, emits sentence-level chunks to a consumer callback,
accumulates the full response, handles backpressure via a high-water-mark queue,
and word-wraps output to a configurable terminal column width.

## Status
**quarantine** - self-contained implementation, not yet wired into the agent loop
or any provider adapter.

## Integration Path
1. Import `ResponseStreamer` from `packages/tools/response-streamer.ts`.
2. Instantiate with `onChunk` (write to terminal / TUI component) and
   `onComplete` (save to memory / history).
3. In the AI SDK streaming loop, call `streamer.push(token)` for each delta and
   `streamer.end()` on stream close.
4. Respect the boolean return of `push()` - if it returns `false`, pause reading
   from the upstream iterator until the queue drains (backpressure contract).
5. Wire into `packages/eight/agent.ts` alongside the existing abort logic.

## Files
- `packages/tools/response-streamer.ts` - implementation (~130 lines)
