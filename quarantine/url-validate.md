# url-validate

Validate URLs with configurable protocol and hostname rules.

## Requirements
- validate(url) returns {ok, reason?}
- isAbsolute(url) checks for scheme
- hasProtocol(url, ...protocols) checks allowed protocols
- isSafeRedirect(url, allowedHosts[]) prevents open redirects
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/url-validate.ts`
