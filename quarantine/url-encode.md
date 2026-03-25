# url-encode

URL percent-encoding and decoding utilities.

## Requirements
- encode(str: string) -> string full percent-encoding
- decode(str: string) -> string
- encodeComponent(str) -> string (like encodeURIComponent but stricter)
- encodeForm(obj: Record<string, string>) -> string application/x-www-form-urlencoded
- decodeForm(str: string) -> Record<string, string>

## Status

Quarantine - pending review.

## Location

`packages/tools/url-encode.ts`
