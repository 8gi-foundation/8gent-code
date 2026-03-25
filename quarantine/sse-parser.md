# sse-parser

## Description

Parses Server-Sent Events (SSE) streams from HTTP responses. Implements the full SSE spec: `event`, `data`, `id`, and `retry` fields, multi-line data concatenation, typed events via generics, and an async iterator interface for ergonomic streaming consumption. Includes auto-JSON parsing for structured payloads and reconnection retry support.

## Status

**quarantine** - self-contained, zero external dependencies, not yet wired into agent tooling.

## Exports

| Export | Description |
|--------|-------------|
| `parseSSE(stream, opts?)` | Convenience async generator. Yields `SSEEvent<T>` from a `ReadableStream<Uint8Array>`. |
| `SSEParser<T>` | Class with `.stream(body)` async generator method. Accepts options for data parsing and event callbacks. |
| `SSEEvent<T>` | Interface: `type`, `data`, `id?`, `retry?`. |
| `SSEParserOptions<T>` | Options: `dataParser`, `onRetry`, `onId`. |

## Integration Path

1. Wire into `packages/eight/tools.ts` so Eight can consume streaming API responses (OpenRouter, Ollama, any SSE endpoint) without duplicating parsing logic across providers.
2. Replace ad-hoc stream handling in `packages/providers/` - each provider currently rolls its own SSE parsing; centralise on this.
3. Use in `packages/daemon/` for streaming session events over WebSocket connections that proxy SSE sources.

## Source

`packages/tools/sse-parser.ts`
