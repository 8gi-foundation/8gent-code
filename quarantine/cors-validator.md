# cors-validator

CORS policy validator that checks headers against a ruleset for common misconfigurations.

## Requirements
- validate(headers{}, allowedOrigins[]): returns violations[]
- check ACAO wildcard with credentials
- check exposed headers for sensitive data (Authorization, Set-Cookie)
- check preflight response correctness
- renderReport(result): markdown CORS audit with severity per issue

## Status

Quarantine - pending review.

## Location

`packages/tools/cors-validator.ts`
