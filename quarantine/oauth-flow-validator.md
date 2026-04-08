# oauth-flow-validator

OAuth 2.0 flow validator checking state parameter, PKCE, redirect URI, and scope handling.

## Requirements
- validateAuthRequest(params{}): checks response_type, client_id, redirect_uri, state, scope
- validateCallback(params{}, expectedState): verifies state matches, checks error field
- validatePKCE(codeVerifier, codeChallenge, method): S256 and plain verification
- renderReport(validations): markdown OAuth flow audit

## Status

Quarantine - pending review.

## Location

`packages/tools/oauth-flow-validator.ts`
