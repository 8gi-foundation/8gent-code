# hex-codec

Efficient hex encoding and decoding for binary data.

## Requirements
- encode(input: Uint8Array | string) -> string (lowercase hex)
- decode(hex: string) -> Uint8Array
- toHex(num: number, padTo?: number) -> string
- fromHex(hex: string) -> number
- Validate input and throw descriptive errors

## Status

Quarantine - pending review.

## Location

`packages/tools/hex-codec.ts`
