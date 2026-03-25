# Quarantine: http-status

## Status
Quarantined - pending integration review.

## Location
`packages/tools/http-status.ts`

## What It Does
HTTP status code constants and classification helpers. RFC 9110 compliant.

## Constants
Covers 1xx, 2xx, 3xx, 4xx, and 5xx ranges. Common codes exported by name:
`OK`, `CREATED`, `NOT_FOUND`, `UNAUTHORIZED`, `INTERNAL_SERVER_ERROR`, etc.

## Helpers

| Function | Returns |
|----------|---------|
| `isSuccess(code)` | true for 2xx |
| `isRedirect(code)` | true for 3xx |
| `isClientError(code)` | true for 4xx |
| `isServerError(code)` | true for 5xx |
| `isError(code)` | true for 4xx or 5xx |
| `isInformational(code)` | true for 1xx |
| `statusText(code)` | standard reason phrase string |

## Usage

```ts
import { OK, NOT_FOUND, isSuccess, isClientError, statusText } from "./packages/tools/http-status.ts";

isSuccess(200);         // true
isClientError(404);     // true
statusText(503);        // "Service Unavailable"
```

## Integration Notes
- No dependencies - pure constants and range checks.
- Drop-in for any HTTP client or server response handling logic.
- Complements `rate-limit-headers.ts` already in `packages/tools/`.
