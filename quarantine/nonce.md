# nonce

Generate cryptographically secure nonces for CSP and tokens.

## Requirements
- generate(len?) returns base64url nonce
- generateHex(len?) returns hex nonce
- verify(nonce, stored) timing-safe comparison
- Used for script nonces and form tokens
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/nonce.ts`
