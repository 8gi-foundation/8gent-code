# base32

Base32 encoding and decoding (RFC 4648).

## Requirements
- encode(input: Uint8Array | string) -> string
- decode(input: string) -> Uint8Array
- Support standard alphabet (A-Z 2-7) and hex alphabet
- Proper padding with '='
- Throw on invalid input characters

## Status

Quarantine - pending review.

## Location

`packages/tools/base32.ts`
