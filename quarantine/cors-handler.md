# cors-handler

CORS policy evaluator for server-side request validation.

## Requirements
- CorsPolicy: allowedOrigins, methods, headers, maxAge
- isAllowed(origin, method) returns boolean
- buildHeaders(origin, method) returns response headers object
- Wildcard origin support
- Preflight detection helper

## Status

Quarantine - pending review.

## Location

`packages/tools/cors-handler.ts`
