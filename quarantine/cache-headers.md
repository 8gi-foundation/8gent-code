# cache-headers

Parse and build HTTP cache control headers.

## Requirements
- parse(headerValue) returns CacheControl object
- build(options) generates Cache-Control header string
- isStale(headers, age) checks if resource is stale
- mustRevalidate(headers) boolean check
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/cache-headers.ts`
