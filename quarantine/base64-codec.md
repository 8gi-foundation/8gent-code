# base64-codec

**Status:** quarantine

## Description

Self-contained base64 encode/decode utility with standard (RFC 4648 §4) and URL-safe (RFC 4648 §5) variants, plus a streaming encoder for large payloads.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `encode` | `(input: string \| Buffer \| Uint8Array) => string` | Standard base64 encode |
| `decode` | `(input: string) => string` | Standard base64 decode to UTF-8 string |
| `decodeToBuffer` | `(input: string) => Buffer` | Standard base64 decode to raw Buffer |
| `encodeUrlSafe` | `(input: string \| Buffer \| Uint8Array) => string` | URL-safe base64 encode (no +/=, uses -_) |
| `decodeUrlSafe` | `(input: string) => string` | URL-safe base64 decode to UTF-8 string |
| `isBase64` | `(input: string) => boolean` | Validate standard base64 string |
| `isBase64UrlSafe` | `(input: string) => boolean` | Validate URL-safe base64 string |
| `streamEncoder` | `(data, options: StreamEncoderOptions) => void` | Chunk-based encoder for large data |

## Integration Path

- Wire into `packages/eight/tools.ts` as a tool action (encode/decode tool for the agent).
- Use `encodeUrlSafe` / `decodeUrlSafe` in `packages/daemon/` for JWT-adjacent payload handling.
- Use `streamEncoder` in `packages/memory/` when serialising large embedding blobs.

## File

`packages/tools/base64-codec.ts` - 140 lines, zero external dependencies.
