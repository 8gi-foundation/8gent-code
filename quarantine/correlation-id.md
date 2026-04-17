# correlation-id

Generate and propagate correlation IDs across requests.

## Requirements
- generate() returns UUID-like correlation ID
- fromHeaders(headers) extracts X-Correlation-ID or X-Request-ID
- toHeaders(id) returns header object
- isValid(id) checks format
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/correlation-id.ts`
