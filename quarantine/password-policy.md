# password-policy

Validate passwords against configurable security policies.

## Requirements
- PasswordPolicy: minLength, requireUpper, requireDigit, requireSymbol
- validate(password, policy) returns {ok, violations[]}
- strength(password) returns score 0-100
- generateStrong(len?) returns policy-compliant password
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/password-policy.ts`
