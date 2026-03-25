# Quarantine: ip-range

**Package:** `packages/tools/ip-range.ts`
**Status:** Quarantine - under review before wiring into agent toolchain

## What it does

IPv4 address range operations with CIDR and start/end range support.

## API

```ts
import { IpRange, fromCIDR, fromRange } from "./packages/tools/ip-range";

// From CIDR
const subnet = fromCIDR("192.168.1.0/24");
subnet.first();         // "192.168.1.0"
subnet.last();          // "192.168.1.255"
subnet.count();         // 256
subnet.contains("192.168.1.100"); // true

// From explicit range
const range = fromRange("10.0.0.1", "10.0.0.50");
range.count();          // 50
range.expand();         // ["10.0.0.1", ..., "10.0.0.50"]

// Overlap and merge
const a = fromCIDR("10.0.0.0/25");
const b = fromCIDR("10.0.0.64/26");
a.overlap(b);           // false
const c = fromCIDR("10.0.0.0/24");
c.overlap(a);           // true
c.merge(a).toString();  // "10.0.0.0-10.0.0.255 (256 IPs)"
```

## Design decisions

- IPv4 only - IPv6 is out of scope for this quarantine pass.
- `expand()` is capped at 65536 by default to avoid memory blowout on large CIDR blocks (/8 etc).
- `merge()` requires ranges to overlap or be adjacent - non-contiguous merges throw.
- All IP math uses unsigned 32-bit integers (`>>> 0`) to avoid JS sign issues.

## Blast radius

- 1 new file: `packages/tools/ip-range.ts`
- 1 new file: `quarantine/ip-range.md`
- Zero existing files modified.

## Next steps (if promoted)

- Wire into `packages/eight/tools.ts` as a tool the agent can call.
- Add IPv6 support if needed.
- Add `toJSON()` / `fromJSON()` for serialisation across agent sessions.
