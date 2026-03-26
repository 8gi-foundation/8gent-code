# webhook-verifier

Verify HMAC signatures on incoming webhooks (GitHub, Stripe style).

## Requirements
- verify(payload, signature, secret, algorithm?) returns boolean
- Timing-safe comparison
- Supports sha256 and sha1 prefix formats
- parse(header) extracts algorithm and hex from 'sha256=xxx'
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/webhook-verifier.ts`
