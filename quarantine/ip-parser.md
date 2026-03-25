# ip-parser

## Tool Name
`ip-parser`

## Description
Parses and validates IPv4 and IPv6 addresses with CIDR subnet support. Provides format conversion between IPv4 and IPv4-mapped IPv6 representations.

## Exports
- `parseIP(str)` - Parse an IPv4 or IPv6 string into a structured object with address, version, numeric bigint, and expanded form. Returns null if invalid.
- `isInSubnet(ip, cidr)` - Check whether an IP address falls within a CIDR range (e.g. `"10.0.1.5"`, `"10.0.0.0/8"`). Supports both IPv4 and IPv6.
- `classifyIP(ip)` - Classify an address as `private`, `public`, `loopback`, `link-local`, `multicast`, or `unspecified`.
- `ipv4ToMappedIPv6(ip)` - Convert an IPv4 address to its IPv4-mapped IPv6 form (`::ffff:x.x.x.x`).
- `mappedIPv6ToIPv4(ip)` - Extract the IPv4 portion from an IPv4-mapped IPv6 address.

## Status
`quarantine`

No external dependencies. Self-contained TypeScript using only `bigint` arithmetic. Not yet wired into the agent tool registry or permissions policy.

## Integration Path
1. Register in `packages/eight/tools.ts` under a `network` or `utilities` category.
2. Add a NemoClaw policy entry in `packages/permissions/policy-engine.ts` if subnet checks are used in automated flows.
3. Optionally expose as a CLI tool via the agent tool dispatch in `packages/tools/`.
4. Add to the quarantine bench test suite once integration is confirmed working end-to-end.
