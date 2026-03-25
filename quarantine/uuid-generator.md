# uuid-generator

## Description

Zero-dependency UUID generator supporting v4 (random), v7 (time-sortable), and URL-safe nano IDs. Includes validation and v7 timestamp extraction. Uses the Web Crypto API (`crypto.getRandomValues`) - no external packages required.

## Status

**quarantine** - implemented, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `uuidv4` | `() => string` | Random UUID v4 |
| `uuidv7` | `() => string` | Time-sortable UUID v7 (Unix ms prefix) |
| `nanoid` | `(length?: number) => string` | URL-safe nano ID, default 21 chars |
| `isUUID` | `(str: string) => boolean` | Format validation for any UUID version |
| `extractTimestampV7` | `(uuid: string) => number \| null` | Extract Unix ms from v7 UUID |
| `batchUUID` | `(count: number, type?: 'v4' \| 'v7') => string[]` | Batch generation helper |

## Integration Path

1. Export from `packages/tools/index.ts` under the `uuid` namespace.
2. Register in `packages/eight/tools.ts` as a tool available to the agent loop.
3. Add to the "9 Powers" browser capability or expose via CLI with `bun -e`.

## Usage

```ts
import { uuidv4, uuidv7, nanoid, isUUID, extractTimestampV7 } from "./packages/tools/uuid-generator.ts";

uuidv4();                         // "550e8400-e29b-41d4-a716-446655440000"
uuidv7();                         // "018e7b7a-f3a2-7c9d-8b1e-5f4a3c2d1e0f"
nanoid();                         // "V1StGXR8_Z5jdHi6B-myT"
nanoid(12);                       // "Ab3_Xy9Zp1Qr"
isUUID("not-a-uuid");             // false
extractTimestampV7(uuidv7());     // 1711234567890
```

## Why Quarantine

No existing UUID utility in the repo. Low risk, high utility. Waiting for a concrete agent use case before wiring into the tool registry to avoid dead code in the agent loop.
