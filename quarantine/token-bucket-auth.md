# token-bucket-auth

Token bucket for per-user API rate limiting with auth context.

## Requirements
- TokenBucket per identity key
- consume(key, tokens?) returns {allowed, remaining, resetAt}
- refill is continuous (not interval-based)
- getState(key) for inspecting bucket
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/token-bucket-auth.ts`
