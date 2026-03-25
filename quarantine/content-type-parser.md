# content-type-parser

## Tool Name

`content-type-parser`

## Description

Parses HTTP `Content-Type` headers into structured components. Extracts the media type, subtype, and all parameters (including `charset` and `boundary`). Provides a `format()` function to serialize back to a canonical header string, plus detection helpers (`isJson`, `isText`, `isHtml`, `isXml`, `isMultipart`).

Self-contained with no external dependencies. Handles quoted parameter values and case normalization.

## Status

`quarantine`

Placed here for review before wiring into the main tool pipeline. Not yet imported by any agent or tool registry.

## Integration Path

1. Import from `packages/tools/content-type-parser.ts` in the browser fetch tool (`packages/tools/browser/`) or any tool that processes HTTP responses.
2. Use `parseContentType(response.headers.get("content-type"))` to branch on response type before processing body.
3. Wire `isJson` / `isHtml` / `isText` into the agent's response-handling logic to replace any ad hoc string matching.
4. Register in the tool registry once validated.

## API

| Export | Signature | Purpose |
|--------|-----------|---------|
| `parseContentType` | `(header: string) => ParsedContentType` | Full parse into structured object |
| `format` | `(parsed: ParsedContentType) => string` | Serialize back to header string |
| `isJson` | `(header: string) => boolean` | Detects `application/json` and `+json` variants |
| `isText` | `(header: string) => boolean` | Detects any `text/*` type |
| `isHtml` | `(header: string) => boolean` | Detects `text/html` only |
| `isXml` | `(header: string) => boolean` | Detects `text/xml`, `application/xml`, `+xml` variants |
| `isMultipart` | `(header: string) => boolean` | Detects `multipart/*` types |
