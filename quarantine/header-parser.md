# header-parser

## Tool Name
`header-parser`

## Description
Parses HTTP-style headers from raw strings and provides case-insensitive access, mutation, and merge utilities. Handles CRLF and LF line endings. All keys are normalized to lowercase internally; `formatHeaders()` title-cases them on output.

Exports:
- `parseHeaders(raw)` - parses a raw header string into a `Map<string, string>`
- `formatHeaders(map)` - serializes a Map back to a CRLF-separated header string with title-cased names
- `getHeader(headers, name)` - case-insensitive header lookup, returns `null` if absent
- `setHeader(headers, name, value)` - sets a header, normalizing the key to lowercase
- `deleteHeader(headers, name)` - removes a header case-insensitively
- `mergeHeaders(a, b)` - merges two Maps, b wins on conflict, returns a new Map
- `hasHeader(headers, name)` - case-insensitive existence check

## Status
**quarantine** - self-contained, no external dependencies. Ready for wiring.

## Integration Path
1. Import into `packages/tools/browser/fetch.ts` - use `parseHeaders()` on raw response headers before passing to `parseRateLimitHeaders()`
2. Wire into agent HTTP utilities in `packages/eight/agent.ts` for normalizing headers before forwarding to sub-agents
3. Use `mergeHeaders()` in any request-building path where default headers need to be combined with per-request overrides
