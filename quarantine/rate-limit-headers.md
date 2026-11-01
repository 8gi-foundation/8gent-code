# rate-limit-headers

## Tool Name
`rate-limit-headers`

## Description
Parses HTTP rate limit headers from API responses and calculates how long to wait before the next request. Supports both the `X-RateLimit-*` convention (GitHub, OpenAI, most REST APIs) and the IETF draft `RateLimit-*` standard, plus `Retry-After`.

Exports:
- `parseRateLimitHeaders(headers)` - extracts limit, remaining, and reset from response headers
- `shouldWait(headers)` - returns milliseconds to wait (0 if safe to proceed)
- `RateLimitTracker` - stateful per-host tracker, call `record()` after each response, `waitFor()` before each request

## Status
**quarantine** - self-contained, no integration yet. Tested manually. Ready for wiring.

## Integration Path
1. Import into `packages/tools/browser/fetch.ts` - call `tracker.record(host, response.headers)` after each fetch, `tracker.waitFor(host)` before retrying
2. Wire into the agent retry loop in `packages/eight/agent.ts` for API calls that hit rate limits
3. Optionally surface wait time in the TUI activity monitor so the user sees why a request is paused
