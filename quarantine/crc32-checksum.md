# crc32-checksum

## Tool Name
crc32-checksum

## Description
CRC32 checksum calculator for data integrity verification. Uses an IEEE 802.3 lookup table for fast computation. Supports strings, Uint8Array buffers, and Node/Bun Buffer inputs. Provides both one-shot and streaming/incremental APIs, with unsigned 32-bit integer and hex output formats.

## Status
quarantine

Isolated from the main tool registry. Not yet registered in packages/eight/tools.ts. Not exposed in the TUI or agent CLI. Pending review and integration approval.

## Exports

| Export | Type | Purpose |
|--------|------|---------|
| crc32(data) | function | One-shot CRC32 as unsigned 32-bit int |
| crc32hex(data) | function | One-shot CRC32 as 8-char hex string |
| crc32Continue(prevCrc, data) | function | Continue an existing CRC over new data |
| CRC32Stream | class | Incremental/streaming CRC32 calculator |

## Integration Path

1. Review - verify correctness against known CRC32 test vectors (e.g., hello world => 0d4a1185)
2. Register - add tool definition to packages/eight/tools.ts under a checksum category
3. Wire CLI - expose via agent CLI
4. TUI - optionally surface in file inspection or memory layer for chunk integrity checks
5. Memory layer - candidate for use in packages/memory/ to detect duplicate or modified episodic memory chunks

## File
packages/tools/crc32-checksum.ts
