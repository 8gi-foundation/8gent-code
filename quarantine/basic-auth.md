# basic-auth

HTTP Basic Authentication header encoder and decoder.

## Requirements
- encode(username, password) returns 'Basic <base64>'
- decode(header) returns {username, password} or null
- validate(header, credentials) timing-safe compare
- isBasicAuth(header) type guard
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/basic-auth.ts`
