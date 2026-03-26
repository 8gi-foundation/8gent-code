# http-retry

HTTP fetch wrapper with exponential backoff retry.

## Requirements
- fetchWithRetry(url, init, opts) retries on 5xx and network errors
- Configurable maxRetries (default 3), baseDelay (default 300ms)
- Exponential backoff with jitter
- Respects Retry-After header
- Returns last response or throws after exhausting retries

## Status

Quarantine - pending review.

## Location

`packages/tools/http-retry.ts`
