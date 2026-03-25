# hmac-sha256

HMAC-SHA256 message authentication using Web Crypto API.

## Requirements
- sign(key: string, message: string) -> Promise<string> (hex output)
- verify(key, message, signature) -> Promise<boolean>
- Works in Node.js via globalThis.crypto (Node 19+) or require('crypto')
- No external dependencies
- Constant-time comparison for verify

## Status

Quarantine - pending review.

## Location

`packages/tools/hmac-sha256.ts`
