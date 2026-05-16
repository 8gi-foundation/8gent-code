# ndjson

Newline-delimited JSON (NDJSON) encoder and decoder.

## Requirements
- encode(records) returns NDJSON string
- decode(text) returns array of parsed objects
- stream(text, onRecord) calls callback per line
- encodeRecord(obj) serializes single line
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/ndjson.ts`
