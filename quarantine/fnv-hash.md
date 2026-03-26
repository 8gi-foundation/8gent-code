# fnv-hash

FNV-1a hash function for fast non-cryptographic hashing.

## Requirements
- fnv1a32(data: string | Uint8Array) -> number
- fnv1a64(data) -> bigint
- fnv1a128(data) -> string (hex)
- Streaming API: FNV class with update(chunk) and digest()
- Pure TypeScript, zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/fnv-hash.ts`
