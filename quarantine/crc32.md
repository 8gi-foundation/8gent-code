# crc32

CRC32 checksum computation for data integrity.

## Requirements
- crc32(data: string | Uint8Array) -> number
- crc32Hex(data) -> string (8-char hex)
- update(crc: number, data) -> number for streaming
- Uses lookup table for performance
- Compatible with standard CRC32 polynomial

## Status

Quarantine - pending review.

## Location

`packages/tools/crc32.ts`
