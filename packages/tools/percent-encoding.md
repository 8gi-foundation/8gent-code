# percent-encoding

**Tool:** `packages/tools/percent-encoding.ts`
**Status:** quarantine

## Description

RFC 3986 compliant percent-encoding and decoding for URL components. Handles path segments, query parameters, and fragment identifiers with correct reserved character sets per the spec. Supports UTF-8 multi-byte characters encoded as multiple `%XX` sequences.

## Exports

| Function | Purpose |
|----------|---------|
| `encodePathComponent(segment)` | Encode a single path segment (no slashes) |
| `encodePath(path)` | Encode a full path, preserving `/` separators |
| `encodeQueryComponent(input)` | Encode a query key or value (encodes `=` and `&`) |
| `encodeFragment(fragment)` | Encode a fragment identifier |
| `decodeComponent(input)` | Decode any percent-encoded string back to UTF-8 |
| `isEncoded(input)` | Detect whether a string contains `%XX` sequences |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/tools/web.ts` when constructing URLs from user-supplied path/query/fragment parts.
3. Use in any agent tool that builds URLs from dynamic parameters (browser tool, health-check, markdown-link-checker).

## Notes

- `encodeQueryComponent` intentionally keeps `?` and `/` unencoded but encodes `=` and `&` since they serve as key-value delimiters inside a query string.
- `decodeComponent` handles contiguous multi-byte UTF-8 sequences - e.g. `%E2%82%AC` decodes to `€`.
- Invalid or incomplete `%XX` sequences in `decodeComponent` are preserved verbatim rather than throwing.
