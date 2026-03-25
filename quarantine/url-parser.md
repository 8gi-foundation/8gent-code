# url-parser

Parse and build URLs with query string manipulation.

## Requirements
- parseUrl(url) returns { protocol, host, port, path, query, hash }
- buildUrl(parts) assembles a URL from parts
- parseQueryString(qs) -> Record<string, string | string[]>
- stringifyQuery(params) -> string
- addQueryParam, removeQueryParam helpers

## Status

Quarantine - pending review.

## Location

`packages/tools/url-parser.ts`
