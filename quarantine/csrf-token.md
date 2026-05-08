# csrf-token

CSRF token generation and double-submit cookie validation.

## Requirements
- generate() returns random token
- validate(cookieToken, formToken) timing-safe compare
- createHeader(token) returns header name and value
- extractFromHeader(headers) pulls token from X-CSRF-Token
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/csrf-token.ts`
