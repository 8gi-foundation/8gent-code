# ip-validate

Validate and classify IP addresses (IPv4 and IPv6).

## Requirements
- isIPv4(str) validates dotted-decimal format
- isIPv6(str) validates colon-hex format
- isPrivate(ip) checks RFC 1918 / fc00::/7 ranges
- normalize(ip) expands IPv6 shorthand
- isLoopback(ip) checks 127.x.x.x / ::1

## Status

Quarantine - pending review.

## Location

`packages/tools/ip-validate.ts`
