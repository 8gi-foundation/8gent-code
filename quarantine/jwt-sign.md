# jwt-sign

Sign and verify JWTs using HMAC-SHA256.

## Requirements
- sign(payload, secret, expiresInSec?) returns JWT string
- verify(token, secret) returns payload or throws
- Uses Web Crypto API (subtleCrypto)
- Handles exp, iat, nbf standard claims
- Zero external dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/jwt-sign.ts`
