# jwt-decode

Decode and validate JWT tokens without a secret (structure only).

## Requirements
- decode(token) returns {header, payload, signature}
- isExpired(payload) checks exp claim
- getClaims(token) returns typed payload object
- validateStructure(token) checks 3-part format
- Zero dependencies, no verification (use jwt-verify for that)

## Status

Quarantine - pending review.

## Location

`packages/tools/jwt-decode.ts`
