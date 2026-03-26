# security-headers-builder

Generates a complete set of recommended HTTP security headers for a web application.

## Requirements
- buildHeaders({ environment, framePolicy?, hstsMaxAge?, cspPolicy? }): returns headers{}
- defaults(env): returns opinionated default headers for development vs production
- toNginxConf(headers): renders as nginx add_header directives
- toExpressMiddleware(headers): renders as Express middleware code snippet

## Status

Quarantine - pending review.

## Location

`packages/tools/security-headers-builder.ts`
