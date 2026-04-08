# oauth-state

Generate and validate OAuth 2.0 state parameters.

## Requirements
- generate() returns random base64url state string
- store(state, metadata) saves with TTL (10 min default)
- consume(state) validates and removes, returns metadata or null
- isExpired(state) checks TTL
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/oauth-state.ts`
