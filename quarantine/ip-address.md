# ip-address

IPv4 and IPv6 address parsing, validation, and manipulation.

## Requirements
- parseIPv4(str) -> { valid: boolean, octets: number[] }
- isValidIPv4(str), isValidIPv6(str)
- ipToLong(ip) -> number and longToIp(n) -> string
- inCIDR(ip, cidr) -> boolean
- expandIPv6(str) -> full form

## Status

Quarantine - pending review.

## Location

`packages/tools/ip-address.ts`
