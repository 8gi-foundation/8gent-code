# secure-random

Cryptographically secure random generators: tokens, UUIDs, passwords, and numeric ranges.

## Requirements
- token(byteLength): hex string from crypto.randomBytes
- password(length, options?): random password with configurable charset
- integer(min, max): unbiased random integer in range using rejection sampling
- choice(array): random element from array
- shuffle(array): Fisher-Yates shuffle using secure random

## Status

Quarantine - pending review.

## Location

`packages/tools/secure-random.ts`
